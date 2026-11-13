// How long after loading the memory of a packmem process settles, per source. Memory only, so CPU load does not matter.
// Usage: [PACKMEM_PG_URL=postgres://...] node bench/settle.mjs   ->  bench/results/<platform>-<arch>-settle.json
// Each source loads in a fresh process, which forces a garbage collection and then samples resident memory and the number
// of resident 256 KB anonymous mappings (V8 heap pages, including freed pages V8 keeps pooled) at fixed times.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const AT = [0, 20, 60, 120, 180];

if (process.argv[2] === "--child") {
  const source = process.argv[3];
  const pm = await import("../index.js");
  const t0 = performance.now();
  let t;
  if (source === "file") t = pm.loadJsonl(here("../../data/flights.jsonl"));
  else {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: process.env.PACKMEM_PG_URL });
    await c.connect();
    t = await pm.fromPg(c, "select * from flights");
    await c.end();
  }
  const loadMs = Math.round(performance.now() - t0);
  // 256 KB anonymous mappings exist only on Linux's /proc; elsewhere report null
  const pages = () => {
    if (!existsSync("/proc/self/smaps")) return null;
    return readFileSync("/proc/self/smaps", "utf8")
      .split(/\n(?=[0-9a-f]+-[0-9a-f]+ )/)
      .filter((b) => {
        const h = b.split("\n")[0].split(/\s+/);
        if (h[5]) return false;
        const [s, e] = h[0].split("-").map((x) => parseInt(x, 16));
        return e - s === 262144 && Number((b.match(/^Rss:\s+(\d+)/m) || [0, 0])[1]) > 0;
      }).length;
  };
  global.gc();
  const start = Date.now();
  const samples = [];
  for (const s of AT) {
    await new Promise((r) => setTimeout(r, Math.max(0, s * 1000 - (Date.now() - start))));
    const m = process.memoryUsage();
    samples.push({ at_s: s, rss_mb: Math.round(m.rss / 1e6), heap_used_mb: Math.round(m.heapUsed / 1e6), pooled_pages: pages() });
  }
  console.log(JSON.stringify({ source, rows: t.length, load_ms: loadMs, samples }));
  process.exit(0);
}

const sources = ["file", ...(process.env.PACKMEM_PG_URL ? ["postgres"] : [])];
const loadBefore = +loadavg()[0].toFixed(2);
const runs = sources.map((s) => {
  const r = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--child", s], { encoding: "utf8", env: process.env });
  if (r.status !== 0) throw new Error(`${s}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
});
const result = {
  machine: { cpu: cpus()[0]?.model, node: process.version, platform: `${process.platform}-${process.arch}`, date: new Date().toISOString(), loadavg_before: loadBefore, loadavg_after: +loadavg()[0].toFixed(2) },
  runs,
};
mkdirSync(here("./results"), { recursive: true });
const out = here(`./results/${process.platform}-${process.arch}-settle.json`);
writeFileSync(out, JSON.stringify(result, null, 2));
for (const r of runs) console.log(`${r.source}: ${r.samples.map((s) => `${s.at_s}s ${s.rss_mb} MB${s.pooled_pages === null ? "" : ` (${s.pooled_pages} pages)`}`).join(", ")}`);
console.log(`results: ${out}`);
