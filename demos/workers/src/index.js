// packmem on Cloudflare Workers, through its WebAssembly build. A Worker has 128 MB of memory, so holding a dataset
// in it is exactly where packed columns help. The data is generated here so the example is self-contained.
// MODE=plain holds the same rows as an array of objects instead, for the benchmark in bench.mjs; every response is
// the same in both modes.
import wasm from "packmem/wasm/packmem.wasm";
import { initSync } from "packmem/wasm";

const pm = initSync(wasm);
const PATHS = ["/", "/pricing", "/docs", "/api/v1/search", "/api/v1/items", "/login", "/blog/packmem"];
const COUNTRIES = ["SE", "DE", "US", "FR", "IN", "BR", "JP"];
let held;

// a deterministic synthetic web log, made in batches of 10,000
function* batches(rows) {
  let s = 42;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let a = 0; a < rows; a += 10_000) {
    const batch = [];
    for (let i = a; i < Math.min(rows, a + 10_000); i++)
      batch.push({ id: i, path: PATHS[Math.floor(rnd() * PATHS.length)], country: COUNTRIES[Math.floor(rnd() * COUNTRIES.length)], status: rnd() < 0.05 ? 404 : 200, ms: Math.round(rnd() * 900) });
    yield batch;
  }
}

const packed = (rows) => {
  // appended batch by batch, so no full array of objects ever exists
  const t = new pm.Table();
  for (const b of batches(rows)) t.extend(b);
  return {
    length: t.length,
    packedMb: +(t.nbytes / 1e6).toFixed(2),
    where: (f) => {
      const v = t.where(f);
      return { length: v.length, byCountry: () => ({ ...v.groupCount("country") }), sum: (c) => v.sum(c), json: () => v.jsonWebStream() };
    },
  };
};

const plain = (rows) => {
  const all = [];
  for (const b of batches(rows)) for (const r of b) all.push(r);
  const keep = (f) => (r) =>
    (f.country === undefined || r.country === f.country) && (f.path === undefined || r.path.startsWith(f.path.prefix)) && (f.status === undefined || r.status === f.status);
  return {
    length: all.length,
    packedMb: null,
    where: (f) => {
      const v = all.filter(keep(f));
      const byCountry = () => {
        const g = {};
        for (const r of v) g[r.country] = (g[r.country] ?? 0) + 1;
        return g;
      };
      return { length: v.length, byCountry, sum: (c) => v.reduce((s, r) => s + r[c], 0), json: () => JSON.stringify(v) };
    },
  };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/stats" && url.pathname !== "/export")
      return new Response("packmem on Workers: try /stats?country=SE&path=/api or /export?status=404\n");
    held ??= (env.MODE === "plain" ? plain : packed)(Number(env.ROWS ?? 200_000));
    const q = Object.fromEntries(url.searchParams);
    const filters = Object.fromEntries(
      Object.entries({ country: q.country, path: q.path ? { prefix: q.path } : undefined, status: q.status ? Number(q.status) : undefined }).filter(([, v]) => v !== undefined),
    );
    if (url.pathname === "/stats") {
      const v = held.where(filters);
      const byCountry = Object.fromEntries(Object.entries(v.byCountry()).sort(([a], [b]) => (a < b ? -1 : 1)));
      return Response.json({ rows: held.length, packed_mb: held.packedMb, matching: v.length, by_country: byCountry, ms_sum: v.sum("ms") });
    }
    // every matching row as one JSON array; packmem writes it from the packed columns and streams it
    return new Response(held.where(filters).json(), { headers: { "content-type": "application/json" } });
  },
};
