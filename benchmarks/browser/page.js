// Runs in the browser page. One call of window.run() fetches one payload and measures it; the runner opens a fresh
// browser context (no cache, new wasm instance) for every call.
const enc = new TextDecoder();

let wasmMemory = null;

// JS heap and ArrayBuffer backing stores after a full GC (CDP Runtime.getHeapUsage, called by the runner), plus the
// WebAssembly linear memory, which Chromium does not count in either
async function measureMemory() {
  const u = await window.heapUsage();
  const wasm = wasmMemory ? wasmMemory.buffer.byteLength : 0;
  return { bytes: u.usedSize + u.backingStorageSize + wasm, js: u.usedSize, buffers: u.backingStorageSize, wasm };
}

function settle() {
  for (let i = 0; i < 3; i++) globalThis.gc();
}

const preds = {
  eq: (col, v) => (r) => r[col] === v,
  contains: (col, v) => (r) => typeof r[col] === "string" && r[col].includes(v),
};

window.run = async ({ url, format, filter }) => {
  const out = { format };
  let pm;
  if (format === "packmem") {
    const t = performance.now();
    const { init } = await import("/pm/wasm.js");
    pm = await init(fetch("/pm/wasm-dist/packmem_bg.wasm"));
    out.wasm_init_ms = performance.now() - t;
    // the bindings' init returns the already-instantiated exports, memory among them
    wasmMemory = (await (await import("/pm/wasm-dist/packmem.js")).default()).memory;
  }
  settle();
  const before = await measureMemory();

  const t0 = performance.now();
  const res = await fetch(url, { cache: "no-store" });
  // gzip inside the payload (packmem/http on main 90602dc): unzipped here, as its fetchTable does
  const gz = /;\s*enc=gzip/i.test(res.headers.get("content-type") ?? "");
  out.unzipped_in_page = gz;
  let buf = await (gz ? new Response(res.body.pipeThrough(new DecompressionStream("gzip"))) : res).arrayBuffer();
  const t1 = performance.now();
  let data =
    format === "json" ? JSON.parse(enc.decode(buf)) : pm.Table.fromBytes(new Uint8Array(buf));
  const t2 = performance.now();
  out.body_ms = t1 - t0;
  out.open_ms = t2 - t1;
  out.ready_ms = t2 - t0;
  out.rows = data.length;

  let t = performance.now();
  const first = data.slice(0, 50);
  out.first50_ms = performance.now() - t;
  out.first50_json = JSON.stringify(first).length;

  const [col, op, v] = filter;
  t = performance.now();
  out.count = format === "json" ? data.filter(preds[op](col, v)).length : data.count({ [col]: op === "eq" ? v : { [op]: v } });
  out.filter_ms = performance.now() - t;

  buf = null;
  window.held = data; // keep the table or the objects alive while measuring
  settle();
  const after = await measureMemory();
  out.mem_before = before.bytes;
  out.mem_after = after.bytes;
  out.mem_held = after.bytes - before.bytes;
  out.mem_held_js = after.js - before.js;
  out.mem_held_buffers = after.buffers - before.buffers;
  out.mem_held_wasm = after.wasm - before.wasm;
  out.mem_how = "CDP Runtime.getHeapUsage (usedSize + backingStorageSize) + WebAssembly memory";

  if (format === "packmem") {
    // every row as an object, which a table view that builds all rows up front would pay
    t = performance.now();
    out.all_rows = data.slice(0, data.length).length;
    out.materialize_all_ms = performance.now() - t;
  }

  const entry = performance.getEntriesByName(new URL(url, location.href).href).at(-1);
  out.transfer_bytes = entry?.transferSize;
  out.encoded_bytes = entry?.encodedBodySize;
  out.decoded_bytes = entry?.decodedBodySize;
  data = null;
  return out;
};
window.ready = true;
