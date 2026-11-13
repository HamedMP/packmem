import type { from, fromPg, fromPgCopy, fromPgResult, fromQuery, parse, parseCsv, Table, View } from "./index.js";

/** The packmem API without file paths or Node streams, running on WebAssembly. */
export interface PackmemWasm {
  Table: typeof Table;
  View: typeof View;
  parse: typeof parse;
  parseCsv: typeof parseCsv;
  from: typeof from;
  fromPg: typeof fromPg;
  fromPgCopy: typeof fromPgCopy;
  fromQuery: typeof fromQuery;
  fromPgResult: typeof fromPgResult;
}

/** Instantiate from a compiled module, synchronously: `import wasm from "packmem/wasm/packmem.wasm"` in Workers. */
export declare function initSync(module: WebAssembly.Module | BufferSource): PackmemWasm;
/** Instantiate from bytes, a Response, a URL or a module. */
export declare function init(input: WebAssembly.Module | BufferSource | Response | URL | string | Promise<Response>): Promise<PackmemWasm>;
