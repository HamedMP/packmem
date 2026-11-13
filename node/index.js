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

/** `{ carrier: "UA", dep_delay: { gt: 60 } }` to `[["carrier","eq","UA"],["dep_delay","gt",60]]`. */
function toSpec(filters) {
  const spec = [];
  for (const [col, cond] of Object.entries(filters ?? {})) {
    if (cond === undefined) continue;
    if (isOps(cond)) {
      for (const [op, v] of Object.entries(cond)) if (v !== undefined) spec.push([col, op, v]);
    } else {
      spec.push([col, "eq", cond]);
    }
  }
  return spec;
}

function groups(text) {
  const out = {};
  for (const [k, n] of JSON.parse(text)) out[k] = (out[k] ?? 0) + n;
  return out;
}

/** JSON array bytes for a set of rows, produced one batch at a time. */
function* jsonChunks(count, batch, render) {
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
  reduce(fn, init) {
    let acc = init;
    let i = 0;
    for (const r of this) acc = fn(acc, r, i++, this);
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
  /** Append records from any iterable of plain objects. */
  extend(records) {
    let lines = [];
    for (const r of records) {
      lines.push(JSON.stringify(r));
      if (lines.length === BATCH) {
        this._t.pushJsonl(lines.join("\n"));
        lines = [];
      }
    }
    if (lines.length) this._t.pushJsonl(lines.join("\n"));
    return this;
  }
  /** Replace row `i`. */
  set(i, row) {
    const j = this._index(i);
    if (j < 0) throw new RangeError(`row ${i} out of range`);
    this._t.setRowJson(j, JSON.stringify(row));
  }
  /** Change some fields of row `i`; a value of `undefined` removes the key. */
  update(i, fields) {
    const j = this._index(i);
    if (j < 0) throw new RangeError(`row ${i} out of range`);
    for (const [k, v] of Object.entries(fields)) this._t.setJson(j, k, v === undefined ? undefined : JSON.stringify(v));
  }

  /** Rows matching every filter: `{ col: value }` or `{ col: { gt, gte, lt, lte, between, prefix, contains, eq } }`. */
  where(filters) {
    return new View(this, toSpec(filters));
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
  constructor(table, spec, parent = null) {
    super();
    this.table = table;
    this.spec = spec;
    this._parent = parent;
    this._ids = null;
  }
  /** Matching row numbers. */
  get ids() {
    if (this._ids) return this._ids;
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
    return new View(this.table, [...this.spec, ...toSpec(filters)], this);
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
    const ids = this.ids;
    const a = Math.min(Math.max(0, offset), ids.length);
    const b = Math.min(ids.length, a + limit);
    return JSON.parse(this.table._t.jsonAt(ids.subarray(a, b)));
  }
  /** Like `rows`, but as JSON bytes: nothing is built in JS. */
  rowsJsonBuffer({ offset = 0, limit = Infinity } = {}) {
    const ids = this.ids;
    const a = Math.min(Math.max(0, offset), ids.length);
    const b = Math.min(ids.length, a + limit);
    return this.table._t.jsonAtBuffer(ids.subarray(a, b));
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

export function from(records, opts) {
  return new Table(records, opts);
}
