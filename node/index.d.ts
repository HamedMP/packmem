import type { Readable } from "node:stream";

export type Hint = "memory" | "balanced" | "speed";
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Row = Record<string, Json>;

export interface Ops {
  eq?: Json;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  between?: [number, number];
  prefix?: string;
  contains?: string;
}
/**
 * `{ col: value }` for equality, or `{ col: { gt: 60 } }`. Every condition must hold. A NaN bound throws
 * TypeError; infinite bounds work; equality with NaN or an infinity matches nothing, as in JavaScript.
 */
export type Filters = Record<string, Json | Ops | undefined>;

declare abstract class Rows<R extends Row = Row> implements Iterable<R> {
  abstract readonly length: number;
  [Symbol.iterator](): Iterator<R>;
  /** JSON array bytes, one batch of rows at a time, written straight from the packed columns. */
  jsonChunks(opts?: { batch?: number }): Generator<Buffer>;
  jsonBuffer(): Buffer;
  /** For `stream.pipe(res)` in Express or Fastify. */
  jsonStream(opts?: { batch?: number }): Readable;
  /** For `new Response(stream)` in Next.js route handlers and other fetch-style servers. */
  jsonWebStream(opts?: { batch?: number }): ReadableStream<Uint8Array>;
  toArray(): R[];
  toJSON(): R[];
  forEach(fn: (row: R, i: number, rows: this) => void): void;
  map<T>(fn: (row: R, i: number, rows: this) => T): T[];
  filter(fn: (row: R, i: number, rows: this) => unknown): R[];
  reduce<T>(fn: (acc: T, row: R, i: number, rows: this) => T, init: T): T;
  /** Without `init`, starts from the first row, as `Array.prototype.reduce` does; throws on an empty table. */
  reduce(fn: (acc: R, row: R, i: number, rows: this) => R): R;
}

export declare class Table<R extends Row = Row> extends Rows<R> {
  constructor(records?: Iterable<R>, opts?: { hint?: Hint });
  readonly length: number;
  readonly names: string[];
  /** Bytes held by the packed columns. */
  readonly nbytes: number;
  at(i: number): R | undefined;
  slice(start?: number, end?: number): R[];
  /** All or nothing: if any record is not an object or cannot be stored, none is added. */
  push(...rows: R[]): number;
  /** All or nothing, like `push`. */
  extend(records: Iterable<R>): this;
  /** Rows as arrays of values in the order of `names` (a database driver's array mode). */
  extendArrays(names: string[], rows: Iterable<unknown[]>): this;
  set(i: number, row: R): void;
  /** A value of `undefined` removes the key. All or nothing. */
  update(i: number, fields: Partial<Record<keyof R, Json | undefined>>): void;
  /** As Array.prototype.splice; returns the removed rows. Each call rebuilds the table once. */
  splice(start: number, deleteCount?: number, ...items: R[]): R[];
  insert(i: number, row: R): number;
  pop(): R | undefined;
  shift(): R | undefined;
  unshift(...rows: R[]): number;
  reverse(): this;
  clear(): void;
  /** Stable, in place: a compare function over records, or `{ key }` with a column name (fast) or a function of a record. */
  sort(how: ((a: R, b: R) => number) | { key: string | ((row: R) => unknown); descending?: boolean }): this;
  /** A new table holding these rows, in this order. */
  take(ids: Iterable<number> | Uint32Array): Table<R>;
  copy(): Table<R>;
  /** Share with worker threads without copying: the table becomes read-only. Send the handle to a worker. */
  share(): SharedTable;
  /** Writable again; workers already reading keep the table they had. */
  unshare(): this;
  /** True while the table is shared (and read-only). */
  readonly shared: boolean;
  /** A read-only table over one another thread of this process shared. */
  static fromShared<R extends Row = Row>(handle: SharedTable): Table<R>;
  /** Rows as lazy objects that read a field only when it is touched; assigning a field writes to the table. */
  lazy(): Generator<LazyRow<R>>;
  where(filters: Filters): View<R>;
  count(filters?: Filters): number;
  sum(column: string, filters?: Filters): number;
  groupCount(column: string, filters?: Filters): Record<string, number>;
  column(name: string, filters?: Filters): Json[];
  compact(): void;
  describe(): { name: string; encoding: string; bytes: number }[];
}

export declare class View<R extends Row = Row> extends Rows<R> {
  readonly table: Table<R>;
  /** Matching row numbers, ascending; recomputed after the table changes. Do not modify. */
  readonly ids: Uint32Array;
  readonly length: number;
  where(filters: Filters): View<R>;
  count(): number;
  sum(column: string): number;
  groupCount(column: string): Record<string, number>;
  column(name: string): Json[];
  rows(opts?: { offset?: number; limit?: number }): R[];
  /** Like `rows`, as JSON array bytes: no objects are built. */
  rowsJsonBuffer(opts?: { offset?: number; limit?: number }): Buffer;
}

export declare function loadJsonl<R extends Row = Row>(path: string | URL, opts?: { hint?: Hint }): Table<R>;
export declare function loadJson<R extends Row = Row>(path: string | URL, opts?: { hint?: Hint }): Table<R>;
/** An array of records or JSON lines, from text or bytes. */
export declare function parse<R extends Row = Row>(input: string | Uint8Array, opts?: { hint?: Hint }): Table<R>;
export declare function from<R extends Row = Row>(records: Iterable<R>, opts?: { hint?: Hint }): Table<R>;

/** Minimal shape of a node-postgres client; `pg.Client`, `pg.PoolClient` fit. */
/** What `table.share()` returns: plain data, safe to send to a worker thread. */
export interface SharedTable {
  readonly packmemShared: string;
  readonly pid: number;
  readonly rows: number;
  readonly columns: string[];
}

export interface PgClientLike {
  query(q: unknown): unknown;
}
/** A query's rows read through `pg-cursor` in batches, straight into a Table. */
export declare function fromPg<R extends Row = Row>(
  client: PgClientLike,
  sql: string,
  params?: unknown[],
  opts?: { batch?: number; hint?: Hint; Cursor?: new (sql: string, params: unknown[], cfg: { rowMode: "array" }) => unknown },
): Promise<Table<R>>;
/** A node-postgres result already in memory (array or object row mode). */
export declare function fromPgResult<R extends Row = Row>(
  result: { fields: { name: string }[]; rows: unknown[] },
  opts?: { hint?: Hint },
): Table<R>;

/** A row read on demand. Column names are properties; `get` reads any key; `toObject` builds the plain record. */
export type LazyRow<R extends Row = Row> = { [K in keyof R]: R[K] | undefined } & {
  get(name: string): Json | undefined;
  toObject(): R;
  toJSON(): R;
  readonly index: number;
};

export type CsvType = "infer" | "text" | "int" | "float" | "bool" | "json";
export interface CsvOptions {
  /** One character; "," by default (`loadTsv` uses a tab). */
  delimiter?: string;
  /** Take column names from the first row (default true); otherwise give `names`. */
  header?: boolean;
  names?: string[];
  /** Per column, by position; later columns are inferred. */
  types?: CsvType[];
  /** An unquoted empty field is null instead of the empty string. */
  emptyIsNull?: boolean;
  hint?: Hint;
}
export declare function loadCsv<R extends Row = Row>(path: string | URL, opts?: CsvOptions): Table<R>;
export declare function loadTsv<R extends Row = Row>(path: string | URL, opts?: CsvOptions): Table<R>;
export declare function parseCsv<R extends Row = Row>(input: string | Uint8Array, opts?: CsvOptions): Table<R>;
/** A query's rows through Postgres COPY as CSV, parsed in the native code. The query takes no parameters. */
export declare function fromPgCopy<R extends Row = Row>(
  client: PgClientLike,
  sql: string,
  opts?: { hint?: Hint; copyTo?: (sql: string) => unknown },
): Promise<Table<R>>;
/** A Drizzle query (`.toSQL()`), a Kysely query (`.compile()`) or `{ sql, params }`, loaded with fromPg. */
export declare function fromQuery<R extends Row = Row>(
  client: PgClientLike,
  query: { toSQL(): { sql: string; params: unknown[] } } | { compile(): { sql: string; parameters: readonly unknown[] } } | { sql: string; params?: unknown[] },
  opts?: { batch?: number; hint?: Hint },
): Promise<Table<R>>;
