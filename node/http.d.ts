import type { Table, View, Row } from "./index.js";

/** The media type of packmem's byte form. */
export declare const PACKMEM_TYPE: "application/vnd.packmem";
/** True when an Accept header (or a request carrying one) asks for packmem bytes ahead of JSON. */
export declare function wantsPackmem(accept: string | Request | { headers: Record<string, string | string[] | undefined> } | null | undefined): boolean;
/** Options for sending bytes. `gzip: false` skips the gzip inside the payload, for when something in front compresses already. */
export interface SendOptions {
  gzip?: boolean;
}
/**
 * A Response with packmem bytes when the request asks for them (gzipped inside the payload, `application/vnd.packmem;
 * enc=gzip`, when it says it reads that), a streamed JSON array otherwise.
 */
export declare function respond(request: Request, rows: Table | View, init?: ResponseInit, options?: SendOptions): Response;
/** As `respond`, for Node's http.ServerResponse (Express, plain node:http). */
export declare function send(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { setHeader(name: string, value: string): unknown; writeHead(status: number, headers: Record<string, string | number>): unknown; write(chunk: Uint8Array): unknown; end(chunk?: Uint8Array): unknown },
  rows: Table | View,
  status?: number,
  options?: SendOptions,
): Promise<void>;
/**
 * Fetch a table: packmem bytes when the server sends them (gzipped or not), else its JSON. `pm` is the API from `packmem`
 * or `packmem/wasm`.
 * Bytes written by a newer packmem than `pm` cannot be read, so then it asks again for JSON.
 */
export declare function fetchTable<R extends Row = Row>(
  pm: { Table: typeof Table; parse: (input: Uint8Array) => Table },
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Table<R>>;
