// packmem compiled to WebAssembly, for runtimes that cannot load a native addon: Cloudflare Workers, Deno, browsers.
// The same engine and the same JavaScript API as the Node addon; file paths and Node streams are not available.
//
//   Cloudflare Workers:  import wasm from "packmem/wasm/packmem.wasm"; const pm = initSync(wasm);
//   elsewhere:           const pm = await init(await (await fetch(url)).arrayBuffer());
import { createApi } from "./api.js";
import initWasm, { initSync as initWasmSync, NativeTable } from "./wasm-dist/packmem.js";

let api;

/** Instantiate from a compiled WebAssembly.Module, synchronously (Workers import .wasm files as modules). */
export function initSync(module) {
  if (!api) {
    initWasmSync({ module });
    api = createApi(NativeTable);
  }
  return api;
}

/** Instantiate from bytes, a Response, a URL or a WebAssembly.Module. */
export async function init(input) {
  if (!api) {
    await initWasm({ module_or_path: input });
    api = createApi(NativeTable);
  }
  return api;
}
