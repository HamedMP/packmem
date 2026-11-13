import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { NativeTable } = require(`./packmem.${process.platform}-${process.arch}.node`);

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
  if (typeof n !== "number" || Number.isNaN(n)) throw new TypeError(`filter ${col}.${op} needs a number, got ${String(v)}`);
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
  yield Buffer.from("[");
  let first = true;
  for (let a = 0; a < count; a += batch) {
    const buf = render(a, Math.min(a + batch, count));
    if (buf.length <= 2) continue;
    if (!first) yield Buffer.from(",");
    first = false;
    yield buf.subarray(1, buf.length - 1);
  }
  yield Buffer.from("]");
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

class Rows {
  /** @returns {Generator<Buffer>} */
  jsonChunks({ batch = BATCH } = {}) {
    return jsonChunks(this.length, batch, (a, b) => this._renderBuffer(a, b));
  }
  /** The rows as a JSON array, as one Buffer. */
  jsonBuffer() {
    return Buffer.concat([...this.jsonChunks()]);
  }
  /** A Node Readable of JSON array bytes, for `stream.pipe(res)`. */
  jsonStream(opts) {
    return Readable.from(this.jsonChunks(opts), { objectMode: false });
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

export class Table extends Rows {
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

export class View extends Rows {
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

/** `lines.map(JSON.parse)` over a JSON-lines file, without the objects. */
export function loadJsonl(path, opts = {}) {
  const t = new Table(undefined, opts);
  t._t.loadJsonlPath(path instanceof URL ? fileURLToPath(path) : String(path));
  return t;
}

/** `JSON.parse(readFileSync(path))` for a file holding an array of records, streamed. */
export function loadJson(path, opts = {}) {
  const t = new Table(undefined, opts);
  t._t.loadJsonArrayPath(path instanceof URL ? fileURLToPath(path) : String(path));
  return t;
}

/** From JSON text or bytes: an array of records, or JSON lines. */
export function parse(input, opts = {}) {
  const t = new Table(undefined, opts);
  const buf = typeof input === "string" ? Buffer.from(input) : Buffer.from(input.buffer ?? input, input.byteOffset, input.byteLength);
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
export async function fromPg(client, sql, params = [], { batch = 10_000, hint, Cursor } = {}) {
  batch = Math.max(1, nonNeg(batch, 10_000));
  Cursor ??= (await import("pg-cursor")).default;
  const cursor = client.query(new Cursor(sql, params, { rowMode: "array" }));
  const read = () => new Promise((resolve, reject) => cursor.read(batch, (err, rows, result) => (err ? reject(err) : resolve([rows, result]))));
  const t = new Table(undefined, { hint });
  t._t.beginBulk();
  try {
    for (;;) {
      const [rows, result] = await read();
      if (!rows.length) break;
      t.extendArrays(result.fields.map((f) => f.name), rows);
    }
  } finally {
    t._t.endBulk();
    await new Promise((resolve) => cursor.close(() => resolve()));
  }
  return t;
}

/** A result already in memory: from `client.query({ text, rowMode: "array" })`, or object rows. */
export function fromPgResult(result, opts) {
  const t = new Table(undefined, opts);
  if (result.rows.length && Array.isArray(result.rows[0])) t.extendArrays(result.fields.map((f) => f.name), result.rows);
  else t.extend(result.rows);
  return t;
}

export function from(records, opts) {
  return new Table(records, opts);
}
