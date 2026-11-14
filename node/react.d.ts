import type { Table, View, Row } from "./index.js";

/** Rows `offset` to `offset + limit` as plain objects, rebuilt only when the range or the table changes. */
export declare function useRows<R extends Row = Row>(rows: Table<R> | View<R> | null | undefined, range?: { offset?: number; limit?: number }): R[];
