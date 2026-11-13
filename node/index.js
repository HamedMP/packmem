import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.js";

const require = createRequire(import.meta.url);
// musl Linux (Alpine) needs its own build: both report linux-x64, so tell them apart by the C library
const isMusl = () => process.platform === "linux" && !process.report?.getReport?.()?.header?.glibcVersionRuntime;
const { NativeTable } = require(`./packmem.${process.platform}-${process.arch}${isMusl() ? "-musl" : ""}.node`);

const api = createApi(NativeTable, { bytes: (u) => (Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength)) });
export const { Table, View, parse, parseCsv, from, fromPg, fromPgCopy, fromQuery, fromPgResult } = api;

/** A Node Readable of JSON array bytes, for `stream.pipe(res)`. */
api.Rows.prototype.jsonStream = function jsonStream(opts) {
  return Readable.from(this.jsonChunks(opts), { objectMode: false });
};

const pathOf = (path) => (path instanceof URL ? fileURLToPath(path) : String(path));

/** `lines.map(JSON.parse)` over a JSON-lines file, without the objects. */
export function loadJsonl(path, opts = {}) {
  const t = new Table(undefined, opts);
  t._t.loadJsonlPath(pathOf(path));
  return t;
}

/** `JSON.parse(readFileSync(path))` for a file holding an array of records, streamed. */
export function loadJson(path, opts = {}) {
  const t = new Table(undefined, opts);
  t._t.loadJsonArrayPath(pathOf(path));
  return t;
}

/**
 * A CSV file straight into columns, read in chunks. Options: `delimiter` (default ","), `header` (default true; otherwise
 * give `names`), `types` per column ("infer", "text", "int", "float", "bool", "json"), `emptyIsNull`.
 */
export function loadCsv(path, opts = {}) {
  const t = new Table(undefined, opts);
  t._t.loadCsvPath(pathOf(path), api.csvOptions(opts));
  return t;
}

export function loadTsv(path, opts = {}) {
  return loadCsv(path, { delimiter: "\t", ...opts });
}
