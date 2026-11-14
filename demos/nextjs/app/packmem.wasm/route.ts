import { readFile } from "node:fs/promises";
import path from "node:path";

/** packmem's WebAssembly build, for the browser page to instantiate. */
export async function GET() {
  const wasm = await readFile(path.join(process.cwd(), "node_modules/packmem/wasm-dist/packmem_bg.wasm"));
  return new Response(new Uint8Array(wasm), { headers: { "content-type": "application/wasm", "cache-control": "public, max-age=3600" } });
}
