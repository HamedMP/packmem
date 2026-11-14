import type { Table, View, Row } from "./index.js";
import type { PackmemWasm } from "./wasm.js";

/** Rows `offset` to `offset + limit` as plain objects, rebuilt only when the range or the table changes. */
export declare function useRows<R extends Row = Row>(rows: Table<R> | View<R> | null | undefined, range?: { offset?: number; limit?: number }): R[];

export interface TableState<R extends Row = Row> {
  /** The latest table; while a new URL loads, the previous one. */
  table: Table<R> | null;
  error: Error | null;
  loading: boolean;
  /** Milliseconds from the request to the table being ready, for the latest table. */
  ms: number;
}

export interface UseTableOptions {
  /** Where packmem/wasm's .wasm file is (a URL, its bytes or a compiled module). Default: the file next to the glue
   * code, which bundlers that understand `new URL(file, import.meta.url)` (Vite, webpack, Next.js) serve for you. */
  wasm?: WebAssembly.Module | BufferSource | Response | URL | string;
  /** An API to read tables with instead of packmem/wasm, e.g. one you already initialized. */
  packmem?: Pick<PackmemWasm, "Table" | "parse">;
  /** Passed to fetch (headers, credentials). */
  init?: RequestInit;
}

/**
 * Fetch a table from `url`: packmem bytes when the server sends them, JSON otherwise. Refetches when `url` changes and
 * drops responses for a URL that is no longer current; `null` fetches nothing. On the server it returns the loading
 * state without fetching.
 */
export declare function useTable<R extends Row = Row>(url: string | URL | null | undefined, options?: UseTableOptions): TableState<R>;
