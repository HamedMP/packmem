// The JavaScript API over a native table, shared by the Node addon (index.js) and the WebAssembly build (wasm.js).
// `NativeTable` is either binding's table class; `bytes` adapts a Uint8Array to what that binding takes and returns
// (Node's Buffer for the addon).
export function createApi(NativeTable, { bytes = (u) => u } = {}) {
  const encoder = new TextEncoder();
  const text = (s) => bytes(encoder.encode(s));
  const toBytes = (input) =>
    bytes(
      typeof input === "string"
        ? encoder.encode(input)
        : input instanceof Uint8Array
          ? input
          : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength),
    );
  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return bytes(out);
  }

  const BATCH = 4096;
  const OPS = new Set(["eq", "gt", "gte", "lt", "lte", "between", "prefix", "contains"]);

  function isOps(v) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every((k) => OPS.has(k));
  }

  /** A range bound: finite numbers as they are, infinities as strings (JSON has none), NaN rejected. */
  function bound(col, op, v) {
    const n = typeof v === "bigint" ? Number(v) : v;
    if (typeof n !== "number" || Number.isNaN(n))
      throw new TypeError(`filter ${col}.${op} needs a number, got ${String(v)}`);
    return Number.isFinite(n) ? n : n > 0 ? "Infinity" : "-Infinity";
  }

  /**
   * `{ carrier: "UA", dep_delay: { gt: 60 } }` to `[["carrier","eq","UA"],["dep_delay","gt",60]]`.
   * `never` is set when a condition cannot match anything (equality with NaN or an infinity, which JSON data cannot hold).
   */
  function toSpec(filters) {
    const spec = [];
    let never = false;
    const add = (col, op, v) => {
      if (v === undefined) return;
      if (op === "eq") {
        if (typeof v === "number" && !Number.isFinite(v)) never = true;
        else spec.push([col, op, typeof v === "bigint" ? Number(v) : v]);
      } else if (op === "between") {
        if (!Array.isArray(v) || v.length !== 2) throw new TypeError(`filter ${col}.between needs [low, high]`);
        spec.push([col, op, [bound(col, op, v[0]), bound(col, op, v[1])]]);
      } else if (op === "prefix" || op === "contains") {
        if (typeof v !== "string") throw new TypeError(`filter ${col}.${op} needs a string`);
        spec.push([col, op, v]);
      } else {
        spec.push([col, op, bound(col, op, v)]);
      }
    };
    for (const [col, cond] of Object.entries(filters ?? {})) {
      if (isOps(cond)) for (const [op, v] of Object.entries(cond)) add(col, op, v);
      else add(col, "eq", cond);
    }
    return { spec, never };
  }

  /** A count or position from user input: a non-negative integer, `def` when it is not a number. */
  function nonNeg(x, def) {
    const n = Number(x);
    return Number.isNaN(n) ? def : Math.max(0, Math.floor(n));
  }

  const isRecord = (r) => r !== null && typeof r === "object" && !Array.isArray(r);

  /** Native errors count lines within one batch; report the record's position in the whole input instead. */
  function inBatch(base, f) {
    try {
      f();
    } catch (e) {
      const m = /^(?:line|row) (\d+): ([\s\S]*)$/.exec(e?.message ?? "");
      if (m) e.message = `record ${base + Number(m[1]) - 1}: ${m[2]}`;
      throw e;
    }
  }

  function bigintSafe(_k, v) {
    return typeof v === "bigint" ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v;
  }

  function groups(text) {
    // no prototype: a value such as "constructor" or "__proto__" is an ordinary key here
    const out = Object.create(null);
    for (const [k, n] of JSON.parse(text)) out[k] = (out[k] ?? 0) + n;
    return out;
  }

  /** JSON array bytes for a set of rows, produced one batch at a time. */
  function* jsonChunks(count, batch, render) {
    batch = Math.max(1, Math.min(nonNeg(batch, BATCH), Math.max(count, 1)));
    yield text("[");
    let first = true;
    for (let a = 0; a < count; a += batch) {
      const buf = render(a, Math.min(a + batch, count));
      if (buf.length <= 2) continue;
      if (!first) yield text(",");
      first = false;
      yield buf.subarray(1, buf.length - 1);
    }
    yield text("]");
  }

  function webStream(chunks) {
    return new ReadableStream({
      pull(controller) {
        const { value, done } = chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      },
    });
  }

  /** Order for sort keys: numbers, then strings, then booleans, then other values; null and missing keys last. */
  function compareKeys(x, y) {
    const rank = (v) =>
      v === undefined
        ? 5
        : v === null
          ? 4
          : typeof v === "number"
            ? 0
            : typeof v === "string"
              ? 1
              : typeof v === "boolean"
                ? 2
                : 3;
    const rx = rank(x),
      ry = rank(y);
    if (rx !== ry) return rx - ry;
    if (rx === 0) return x - y;
    if (rx === 1) return x < y ? -1 : x > y ? 1 : 0;
    if (rx === 2) return Number(x) - Number(y);
    if (rx === 3) {
      const sx = JSON.stringify(x),
        sy = JSON.stringify(y);
      return sx < sy ? -1 : sx > sy ? 1 : 0;
    }
    return 0;
  }

  /** Column `name` for a lazy row's batch, fetched once per batch on first use. */
  function batchColumn(batch, name) {
    let c = batch.cols.get(name);
    if (!c) {
      const { json, missing } = batch.table._t.columnRange(name, batch.a, batch.b);
      c = { values: JSON.parse(json), missing };
      batch.cols.set(name, c);
    }
    return c;
  }

  /** A prototype with one getter and setter per column, so `row.carrier` and `row["carrier"]` read lazily. */
  function lazyPrototype(table, names) {
    const proto = {
      get(name) {
        const c = batchColumn(this._batch, name);
        const k = this._i - this._batch.a;
        return c.missing[k] ? undefined : c.values[k];
      },
      toObject() {
        return JSON.parse(table._t.jsonRange(this._i, this._i + 1))[0];
      },
      toJSON() {
        return this.toObject();
      },
      get index() {
        return this._i;
      },
    };
    for (const name of names) {
      if (name in proto) continue;
      Object.defineProperty(proto, name, {
        enumerable: true,
        get() {
          return this.get(name);
        },
        set(v) {
          table.update(this._i, { [name]: v });
          const c = this._batch.cols.get(name);
          if (c) {
            const k = this._i - this._batch.a;
            c.values[k] = v === undefined ? null : JSON.parse(JSON.stringify(v));
            c.missing[k] = v === undefined ? 1 : 0;
          }
        },
      });
    }
    return proto;
  }

  class Rows {
    /** @returns {Generator<Buffer>} */
    jsonChunks({ batch = BATCH } = {}) {
      return jsonChunks(this.length, batch, (a, b) => this._renderBuffer(a, b));
    }
    /** The rows as a JSON array, as one Buffer (a Uint8Array outside Node). */
    jsonBuffer() {
      return concat([...this.jsonChunks()]);
    }
    /** A web ReadableStream of JSON array bytes, for `new Response(stream)`. */
    jsonWebStream(opts) {
      return webStream(this.jsonChunks(opts));
    }
    toArray() {
      return [...this];
    }
    toJSON() {
      return this.toArray();
    }
    forEach(fn) {
      let i = 0;
      for (const r of this) fn(r, i++, this);
    }
    map(fn) {
      const out = [];
      let i = 0;
      for (const r of this) out.push(fn(r, i++, this));
      return out;
    }
    filter(fn) {
      const out = [];
      let i = 0;
      for (const r of this) if (fn(r, i++, this)) out.push(r);
      return out;
    }
    reduce(fn, ...init) {
      let i = 0;
      let acc;
      let started = init.length > 0;
      if (started) acc = init[0];
      for (const r of this) {
        if (!started) {
          acc = r;
          started = true;
          i++;
          continue;
        }
        acc = fn(acc, r, i++, this);
      }
      if (!started) throw new TypeError("reduce of an empty table with no initial value");
      return acc;
    }
  }

  class Table extends Rows {
    /**
     * @param {Iterable<object>} [records]
     * @param {{ hint?: "memory" | "balanced" | "speed" }} [opts]
     */
    constructor(records, { hint = "balanced" } = {}) {
      super();
      this._t = new NativeTable(hint);
      /** Bumped on every change, so views know to recompute their matches. */
      this._version = 0;
      if (records) this.extend(records);
    }

    get length() {
      return this._t.length;
    }
    get names() {
      return this._t.names();
    }

    _index(i) {
      const n = this._t.length;
      const j = i < 0 ? n + i : i;
      return j >= 0 && j < n ? j : -1;
    }
    _renderBuffer(a, b) {
      return this._t.jsonRangeBuffer(a, b);
    }

    /** One row as a plain object; negative indexes count from the end. */
    at(i) {
      const j = this._index(i);
      return j < 0 ? undefined : JSON.parse(this._t.jsonRange(j, j + 1))[0];
    }
    slice(start = 0, end = this.length) {
      const n = this.length;
      const a = Math.max(0, start < 0 ? n + start : Math.min(start, n));
      const b = Math.max(a, end < 0 ? n + end : Math.min(end, n));
      return JSON.parse(this._t.jsonRange(a, b));
    }
    *[Symbol.iterator]() {
      const n = this._t.length;
      for (let a = 0; a < n; a += BATCH) yield* JSON.parse(this._t.jsonRange(a, Math.min(a + BATCH, n)));
    }

    push(...rows) {
      this.extend(rows);
      return this.length;
    }
    /** Append records from any iterable of plain objects. All or nothing: if any record fails, none is added. */
    extend(records) {
      return this._append(() => {
        let lines = [];
        let i = 0;
        const flush = () => {
          const text = lines.join("\n");
          inBatch(i - lines.length, () => this._t.pushJsonl(text));
          lines = [];
        };
        for (const r of records) {
          if (!isRecord(r)) throw new TypeError(`record ${i} is not an object: ${String(r)}`);
          lines.push(JSON.stringify(r));
          i++;
          if (lines.length === BATCH) flush();
        }
        if (lines.length) flush();
      });
    }
    /**
     * Append rows given as arrays of values in the order of `names`, as database drivers return them in array mode.
     * BigInt values become numbers when they fit exactly and strings otherwise; Dates become ISO strings.
     */
    extendArrays(names, rows) {
      return this._append(() => {
        let lines = [];
        let i = 0;
        const flush = () => {
          const text = lines.join("\n");
          inBatch(i - lines.length, () => this._t.pushArraysJsonl(names, text));
          lines = [];
        };
        for (const r of rows) {
          if (!Array.isArray(r)) throw new TypeError(`row ${i} is not an array`);
          lines.push(JSON.stringify(r, bigintSafe));
          i++;
          if (lines.length === BATCH) flush();
        }
        if (lines.length) flush();
      });
    }
    /** One append as a unit: packed once at the end, and rolled back if anything in it fails. */
    _append(f) {
      const start = this._t.length;
      try {
        this._bulk(f);
      } catch (e) {
        this._t.truncate(start);
        throw e;
      } finally {
        this._version++;
      }
      return this;
    }
    /** Run `f` as one bulk load: rows are packed once at the end instead of after every batch. */
    _bulk(f) {
      this._t.beginBulk();
      try {
        return f();
      } finally {
        this._t.endBulk();
      }
    }
    /** Replace row `i`. */
    set(i, row) {
      const j = this._index(i);
      if (j < 0) throw new RangeError(`row ${i} out of range`);
      if (!isRecord(row)) throw new TypeError("a row must be an object");
      this._t.setRowJson(j, JSON.stringify(row));
      this._version++;
    }
    /** Change some fields of row `i`; a value of `undefined` removes the key. All or nothing. */
    update(i, fields) {
      const j = this._index(i);
      if (j < 0) throw new RangeError(`row ${i} out of range`);
      if (!isRecord(fields)) throw new TypeError("fields must be an object");
      const remove = Object.keys(fields).filter((k) => fields[k] === undefined);
      this._t.updateJson(j, JSON.stringify(fields), remove);
      this._version++;
    }

    // ---------- list operations: each is one rebuild of the packed table ----------

    _reorder(ids) {
      this._t.reorder(ids instanceof Uint32Array ? ids : Uint32Array.from(ids));
      this._version++;
    }
    /** Remove `deleteCount` rows at `start` and insert `items` there, as Array.prototype.splice; returns the removed rows. */
    splice(start, deleteCount, ...items) {
      const n = this.length;
      const s = start < 0 ? Math.max(0, n + Math.trunc(start)) : Math.min(n, Math.trunc(start) || 0);
      const del = deleteCount === undefined ? n - s : Math.max(0, Math.min(n - s, Math.trunc(deleteCount) || 0));
      const removed = del ? JSON.parse(this._t.jsonRange(s, s + del)) : [];
      if (!del && !items.length) return removed;
      this.extend(items); // appended at the end (all or nothing), then moved into place
      const ids = new Uint32Array(n - del + items.length);
      let k = 0;
      for (let i = 0; i < s; i++) ids[k++] = i;
      for (let i = 0; i < items.length; i++) ids[k++] = n + i;
      for (let i = s + del; i < n; i++) ids[k++] = i;
      this._reorder(ids);
      return removed;
    }
    /** Insert one record before row `i`. */
    insert(i, row) {
      this.splice(i, 0, row);
      return this.length;
    }
    pop() {
      return this.length ? this.splice(-1, 1)[0] : undefined;
    }
    shift() {
      return this.length ? this.splice(0, 1)[0] : undefined;
    }
    unshift(...rows) {
      this.splice(0, 0, ...rows);
      return this.length;
    }
    reverse() {
      const n = this.length;
      const ids = new Uint32Array(n);
      for (let i = 0; i < n; i++) ids[i] = n - 1 - i;
      this._reorder(ids);
      return this;
    }
    clear() {
      this._t.clear();
      this._version++;
    }
    /**
     * Sort in place, stably. Either `compareFn(a, b)` over plain records, as Array.prototype.sort, or
     * `{ key, descending }` where `key` is a column name (fast: one column is read) or a function of a record.
     */
    sort(how) {
      const n = this.length;
      let order;
      if (typeof how === "function") {
        const rows = this.toArray();
        order = Array.from({ length: n }, (_, i) => i).sort((a, b) => how(rows[a], rows[b]));
      } else {
        const { key, descending = false } = how ?? {};
        if (key === undefined) throw new TypeError("sort needs a compare function or { key }");
        const keys = typeof key === "string" ? this._keysOf(key) : this.map((r) => key(r));
        order = Array.from({ length: n }, (_, i) => i).sort(
          (a, b) => compareKeys(keys[a], keys[b]) * (descending ? -1 : 1) || a - b,
        );
      }
      this._reorder(order);
      return this;
    }
    _keysOf(column) {
      const { json, missing } = this._t.columnRange(column, 0, this.length);
      const v = JSON.parse(json);
      for (let i = 0; i < missing.length; i++) if (missing[i]) v[i] = undefined;
      return v;
    }
    /** A new table holding these rows, in this order (ids may repeat or be left out). */
    take(ids) {
      const out = new Table();
      out._t = this._t.take(ids instanceof Uint32Array ? ids : Uint32Array.from(ids));
      return out;
    }
    copy() {
      return this.take(Uint32Array.from({ length: this.length }, (_, i) => i));
    }

    /**
     * Iterate rows as lazy objects: a field is read from the packed column only when the loop touches it, one column per
     * batch of 4,096 rows. Faster than full objects for loops that read a few fields; assigning a field writes to the table.
     */
    *lazy() {
      const n = this.length;
      const names = this.names;
      const proto = lazyPrototype(this, names);
      for (let a = 0; a < n; a += BATCH) {
        const batch = { table: this, a, b: Math.min(a + BATCH, n), cols: new Map() };
        for (let i = batch.a; i < batch.b; i++) {
          const row = Object.create(proto);
          row._batch = batch;
          row._i = i;
          yield row;
        }
      }
    }

    /** Rows matching every filter: `{ col: value }` or `{ col: { gt, gte, lt, lte, between, prefix, contains, eq } }`. */
    where(filters) {
      const { spec, never } = toSpec(filters);
      return new View(this, spec, null, never);
    }
    count(filters) {
      return filters ? this.where(filters).length : this.length;
    }
    sum(column, filters) {
      return filters ? this.where(filters).sum(column) : this._t.sum(column);
    }
    /** `{ value: count }` for one column. */
    groupCount(column, filters) {
      return filters ? this.where(filters).groupCount(column) : groups(this._t.groupCount(column));
    }
    column(name, filters) {
      return filters ? this.where(filters).column(name) : JSON.parse(this._t.columnJson(name));
    }

    compact() {
      this._t.compact();
    }
    /** Bytes held by the packed columns. */
    get nbytes() {
      return this._t.nbytes();
    }
    describe() {
      return JSON.parse(this._t.describe()).map(([name, encoding, bytes]) => ({ name, encoding, bytes }));
    }
  }

  class View extends Rows {
    constructor(table, spec, parent = null, never = false) {
      super();
      this.table = table;
      this.spec = spec;
      this._parent = parent;
      this._never = never || !!parent?._never;
      this._ids = null;
      this._version = -1;
    }
    /** Matching row numbers, ascending. Recomputed when the table has changed since the last use. */
    get ids() {
      if (this._ids && this._version === this.table._version) return this._ids;
      this._version = this.table._version;
      if (this._never) return (this._ids = new Uint32Array(0));
      const own = this._parent ? this.spec.slice(this._parent.spec.length) : this.spec;
      return (this._ids = this.table._t.select(JSON.stringify(own), this._parent?.ids));
    }
    get length() {
      return this.ids.length;
    }
    _renderBuffer(a, b) {
      return this.table._t.jsonAtBuffer(this.ids.subarray(a, b));
    }
    where(filters) {
      const { spec, never } = toSpec(filters);
      return new View(this.table, [...this.spec, ...spec], this, never);
    }
    count() {
      return this.length;
    }
    sum(column) {
      return this.table._t.sum(column, this.ids);
    }
    groupCount(column) {
      return groups(this.table._t.groupCount(column, this.ids));
    }
    column(name) {
      return JSON.parse(this.table._t.columnJson(name, this.ids));
    }
    /** Matching rows as plain objects. */
    rows({ offset = 0, limit = Infinity } = {}) {
      return JSON.parse(this.table._t.jsonAt(this._window(offset, limit)));
    }
    _window(offset, limit) {
      const ids = this.ids;
      const a = Math.min(nonNeg(offset, 0), ids.length);
      return ids.subarray(a, Math.min(ids.length, a + nonNeg(limit, Infinity)));
    }
    /** Like `rows`, but as JSON bytes: nothing is built in JS. */
    rowsJsonBuffer({ offset = 0, limit = Infinity } = {}) {
      return this.table._t.jsonAtBuffer(this._window(offset, limit));
    }
    *[Symbol.iterator]() {
      const ids = this.ids;
      for (let a = 0; a < ids.length; a += BATCH) yield* JSON.parse(this.table._t.jsonAt(ids.subarray(a, a + BATCH)));
    }
  }

  /** From JSON text or bytes: an array of records, or JSON lines. */
  function parse(input, opts = {}) {
    const t = new Table(undefined, opts);
    const buf = toBytes(input);
    let i = 0;
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++;
    if (buf[i] === 0x5b) t._t.pushJsonArrayBuffer(buf);
    else t._t.pushJsonlBuffer(buf);
    return t;
  }

  /**
   * A query's result from node-postgres (`pg`), read in batches through a cursor so neither the driver nor packmem
   * builds an object per row. Needs the `pg-cursor` package; pass its class as `Cursor` if it is not resolvable from here.
   */
  async function fromPg(client, sql, params = [], { batch = 10_000, hint, Cursor } = {}) {
    batch = Math.max(1, nonNeg(batch, 10_000));
    Cursor ??= (await optionalImport("pg-cursor")).default;
    const cursor = client.query(new Cursor(sql, params, { rowMode: "array" }));
    const read = () =>
      new Promise((resolve, reject) =>
        cursor.read(batch, (err, rows, result) => (err ? reject(err) : resolve([rows, result]))),
      );
    const t = new Table(undefined, { hint });
    t._t.beginBulk();
    try {
      for (;;) {
        const [rows, result] = await read();
        if (!rows.length) break;
        t.extendArrays(
          result.fields.map((f) => f.name),
          rows,
        );
      }
    } finally {
      t._t.endBulk();
      await new Promise((resolve) => cursor.close(() => resolve()));
    }
    return t;
  }

  // ---------- CSV ----------

  /**
 * Import an optional peer dependency by a computed name, so bundlers (esbuild in wrangler, Vite) do not try to resolve
 * it at build time when the app does not use it.
 */
const optionalImport = (name) => import(/* @vite-ignore */ /* webpackIgnore: true */ name);

function csvOptions(o = {}) {
    return JSON.stringify({
      delimiter: o.delimiter,
      header: o.header,
      names: o.names,
      types: o.types,
      emptyIsNull: o.emptyIsNull,
    });
  }

  /** CSV from text or bytes. */
  function parseCsv(input, opts = {}) {
    const t = new Table(undefined, opts);
    t._t.csvBegin(csvOptions(opts));
    t._t.csvFeed(toBytes(input));
    t._t.csvFinish();
    return t;
  }

  // node-postgres types its results by column type; COPY sends text, so the same mapping is applied in the native parser
  const PG_TYPES = {
    16: "bool",
    21: "int",
    23: "int",
    26: "int",
    700: "float",
    701: "float",
    114: "json",
    3802: "json",
  };

  /**
   * A query's rows through Postgres COPY, parsed as CSV in the native code: no row objects in the driver or in JavaScript.
   * Needs `pg-copy-streams` (pass its `to` as `copyTo` if it is not resolvable from here). The query cannot take
   * parameters (COPY does not accept them). Values are typed as node-postgres types them (int8 and numeric as strings,
   * json as nested values), except dates and timestamps, which stay as Postgres prints them instead of becoming Dates.
   */
  async function fromPgCopy(client, sql, { hint, copyTo } = {}) {
    copyTo ??= (await optionalImport("pg-copy-streams")).to;
    const probe = await client.query({ text: `SELECT * FROM (${sql}) AS packmem_q LIMIT 0`, rowMode: "array" });
    const types = probe.fields.map((f) => PG_TYPES[f.dataTypeID] ?? "text");
    const t = new Table(undefined, { hint });
    t._t.csvBegin(csvOptions({ header: true, types, emptyIsNull: true }));
    let open = true;
    try {
      const stream = client.query(copyTo(`COPY (${sql}) TO STDOUT WITH (FORMAT csv, HEADER true)`));
      for await (const chunk of stream) t._t.csvFeed(chunk);
      open = false;
      t._t.csvFinish();
    } catch (e) {
      if (open) {
        try {
          t._t.csvFinish();
        } catch {
          // the stream already failed; its error is the one to report
        }
      }
      throw e;
    }
    return t;
  }

  /**
   * A query built with Drizzle (`.toSQL()`), Kysely (`.compile()`) or given as `{ sql, params }`, loaded with fromPg.
   * `client` is the node-postgres client behind the query builder.
   */
  async function fromQuery(client, query, opts) {
    const q =
      typeof query?.toSQL === "function"
        ? query.toSQL()
        : typeof query?.compile === "function"
          ? query.compile()
          : query;
    if (!q || typeof q.sql !== "string")
      throw new TypeError("fromQuery needs a Drizzle or Kysely query, or { sql, params }");
    return fromPg(client, q.sql, q.params ?? q.parameters ?? [], opts);
  }

  /** A result already in memory: from `client.query({ text, rowMode: "array" })`, or object rows. */
  function fromPgResult(result, opts) {
    const t = new Table(undefined, opts);
    if (result.rows.length && Array.isArray(result.rows[0]))
      t.extendArrays(
        result.fields.map((f) => f.name),
        result.rows,
      );
    else t.extend(result.rows);
    return t;
  }

  function from(records, opts) {
    return new Table(records, opts);
  }

  return { Table, View, Rows, parse, parseCsv, csvOptions, from, fromPg, fromPgCopy, fromQuery, fromPgResult };
}
