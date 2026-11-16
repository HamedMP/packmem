// Archive benchmark on synthetic agent history (bench/agent-history-data.mjs). Writes one raw JSON result.
// Usage: node bench/agent-history.mjs <data-dir> <work-dir> <result.json> <mode>
// mode archive: packmem archive vs zstd -19 per file vs one zstd -19 stream with a 128 MB window.
// mode use: one history-wide question (records by type), from packmem tables vs from zstd files.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import * as api from "../archive/archive.js";
import * as pm from "../index.js";

const [data, work, resultPath, mode] = process.argv.slice(2);
const roots = { "claude-code": [join(data, "claude", "projects")], codex: [join(data, "codex", "sessions")] };
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".jsonl") ? [join(d, e.name)] : []));
const files = [...walk(roots["claude-code"][0]), ...walk(roots.codex[0])].sort();
const rawBytes = files.reduce((n, f) => n + statSync(f).size, 0);
const L = zlib.constants;
const z19 = (buf, windowLog) => zlib.zstdCompressSync(buf, { params: { [L.ZSTD_c_compressionLevel]: 19, ...(windowLog ? { [L.ZSTD_c_windowLog]: windowLog } : {}) } });
const env = { node: process.version, platform: `${process.platform}-${process.arch}`, cpu: cpus()[0]?.model, cores: cpus().length, load_start: loadavg().map((x) => +x.toFixed(2)) };
const result = { mode, env, data: { sessions: files.length, raw_bytes: rawBytes } };
mkdirSync(work, { recursive: true });

if (mode === "archive") {
  let t = performance.now();
  const r = await api.archive({ dir: join(work, "archive"), roots }, { olderThanDays: 0 });
  result.archive = { seconds: +((performance.now() - t) / 1000).toFixed(1), sessions: r.archived, failed: r.failed.length, archive_bytes: (await api.status({ dir: join(work, "archive"), roots })).archiveBytes };
  t = performance.now();
  const v = await api.verify({ dir: join(work, "archive"), roots });
  result.verify = { seconds: +((performance.now() - t) / 1000).toFixed(1), bad: v.bad.length, bytes: v.bytes };
  t = performance.now();
  result.zstd19_per_file = { bytes: files.reduce((n, f) => n + z19(readFileSync(f)).length, 0), seconds: 0 };
  result.zstd19_per_file.seconds = +((performance.now() - t) / 1000).toFixed(1);
  t = performance.now();
  result.zstd19_one_stream_window128mb = { bytes: z19(Buffer.concat(files.map((f) => readFileSync(f))), 27).length, seconds: 0 };
  result.zstd19_one_stream_window128mb.seconds = +((performance.now() - t) / 1000).toFixed(1);
} else if (mode === "use") {
  const tables = join(work, "tables");
  const zst = join(work, "zst");
  mkdirSync(tables, { recursive: true });
  mkdirSync(zst, { recursive: true });
  files.forEach((f, i) => {
    writeFileSync(join(tables, `${i}.pm`), pm.loadJsonl(f, { hint: "memory" }).toBytes());
    writeFileSync(join(zst, `${i}.zst`), z19(readFileSync(f)));
  });
  const size = (d) => readdirSync(d).reduce((n, f) => n + statSync(join(d, f)).size, 0);
  const count = (into, groups) => {
    for (const [k, v] of Object.entries(groups)) into[k] = (into[k] ?? 0) + v;
  };
  const rss0 = process.memoryUsage().rss;
  let t = performance.now();
  const a = {};
  for (const f of readdirSync(tables)) count(a, pm.Table.fromBytes(readFileSync(join(tables, f))).groupCount("type"));
  result.packmem_tables = { bytes: size(tables), query_seconds: +((performance.now() - t) / 1000).toFixed(2) };
  t = performance.now();
  const b = {};
  for (const f of readdirSync(zst)) {
    const g = {};
    for (const line of zlib.zstdDecompressSync(readFileSync(join(zst, f))).toString("utf8").split("\n")) if (line) g[JSON.parse(line).type] = (g[JSON.parse(line).type] ?? 0) + 1;
    count(b, g);
  }
  result.zstd19_files = { bytes: size(zst), query_seconds: +((performance.now() - t) / 1000).toFixed(2) };
  result.same_answer = JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  result.rss_growth_note = `process RSS ${((process.memoryUsage().rss - rss0) / 1e6).toFixed(0)} MB above the start of the query phase; run each mode in its own process for peaks`;
}
result.env.load_end = loadavg().map((x) => +x.toFixed(2));
result.max_rss_bytes = process.resourceUsage().maxRSS * 1024;
writeFileSync(resultPath, JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify(result));
