// packmem on Cloudflare Workers, through its WebAssembly build. A Worker has 128 MB of memory, so holding a dataset
// in it is exactly where packed columns help. The data is generated here so the example is self-contained.
import wasm from "packmem/wasm/packmem.wasm";
import { initSync } from "packmem/wasm";

const pm = initSync(wasm);
const ROWS = 200_000;
let table;

function dataset() {
  // deterministic synthetic web log, appended in batches so no full array of objects ever exists
  const t = new pm.Table();
  const paths = ["/", "/pricing", "/docs", "/api/v1/search", "/api/v1/items", "/login", "/blog/packmem"];
  const countries = ["SE", "DE", "US", "FR", "IN", "BR", "JP"];
  let s = 42;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let a = 0; a < ROWS; a += 10_000) {
    const batch = [];
    for (let i = a; i < a + 10_000; i++)
      batch.push({ id: i, path: paths[Math.floor(rnd() * paths.length)], country: countries[Math.floor(rnd() * countries.length)], status: rnd() < 0.05 ? 404 : 200, ms: Math.round(rnd() * 900) });
    t.extend(batch);
  }
  return t;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const t0 = Date.now();
    table ??= dataset();
    const q = Object.fromEntries(url.searchParams);
    const filters = { country: q.country, path: q.path ? { prefix: q.path } : undefined, status: q.status ? Number(q.status) : undefined };
    if (url.pathname === "/stats") {
      const v = table.where(filters);
      return Response.json({ rows: table.length, packed_mb: +(table.nbytes / 1e6).toFixed(2), matching: v.length, by_country: v.groupCount("country"), ms_sum: v.sum("ms"), took_ms: Date.now() - t0 });
    }
    if (url.pathname === "/export") {
      // every matching row as one JSON array, written from the packed columns and streamed
      return new Response(table.where(filters).jsonWebStream(), { headers: { "content-type": "application/json" } });
    }
    return new Response("packmem on Workers: try /stats?country=SE&path=/api or /export?status=404\n");
  },
};
