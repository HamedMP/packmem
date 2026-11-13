// The demo Worker plus one route for bench.mjs: the size of packmem's WebAssembly memory, which the public API does
// not report. It resolves to the same module instance as packmem/wasm, so it reads the memory the demo is using.
import wasm from "packmem/wasm/packmem.wasm";
import { initSync } from "./node_modules/packmem/wasm-dist/packmem.js";
import demo from "./src/index.js";

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/mem")
      return Response.json({ wasm_mb: initSync({ module: wasm }).memory.buffer.byteLength / 1e6 });
    return demo.fetch(request, env, ctx);
  },
};
