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
/** `{ col: value }` for equality, or `{ col: { gt: 60 } }`. Every condition must hold. */
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
}

export declare class Table<R extends Row = Row> extends Rows<R> {
  constructor(records?: Iterable<R>, opts?: { hint?: Hint });
  readonly length: number;
  readonly names: string[];
  /** Bytes held by the packed columns. */
  readonly nbytes: number;
  at(i: number): R | undefined;
  slice(start?: number, end?: number): R[];
  push(...rows: R[]): number;
  extend(records: Iterable<R>): this;
  /** Rows as arrays of values in the order of `names` (a database driver's array mode). */
  extendArrays(names: string[], rows: Iterable<unknown[]>): this;
  set(i: number, row: R): void;
  /** A value of `undefined` removes the key. */
  update(i: number, fields: Partial<Record<keyof R, Json | undefined>>): void;
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
