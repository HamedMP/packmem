// Memory of one process whose main thread and 4 worker threads all read the same records, compared four ways:
//   floor    the same process and workers holding no data: what five V8 isolates cost on their own
//   copy     every worker loads its own packmem table from the file
//   share    the main thread loads once and shares it; workers attach with Table.fromShared
//   objects  plain objects, cloned into each worker through workerData (what worker_threads does by default)
// Two files: the flights (packs to about 8 MB) and a 2-million-row web log (about 65 MB). Objects are measured on the
// flights only: five object copies of the 500 MB log would need well over 10 GB.
// Each run is a fresh process. After the workers have queried and exported, every thread collects garbage, the process
// idles 20 s, and its resident memory is read. Runs alternate between modes; the result keeps every run and the medians.
// Usage: node bench/share.mjs [runs=5]  ->  bench/results/<platform>-<arch>-share.json
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const WORKERS = 4;
const SETTLE_S = Number(process.env.SETTLE_S ?? 20);

/** Per file: the modes measured, and the same reads in every mode (three queries and a JSON export). */
const DATA = {
  flights: {
    file: here("../../data/flights.jsonl"),
    modes: ["floor", "copy", "share", "objects"],
    q: { eq: ["carrier", "UA"], sum: ["distance", "origin", "JFK"], group: "dest" },
  },
  logs_2m: {
    file: here("../../data/logs_2m.jsonl"),
    modes: ["floor", "copy", "share"],
    q: { eq: ["status", 404], sum: ["bytes", "method", "GET"], group: "country" },
  },
};

function work(rows, pm, q) {
  if (!rows) return {};
  const [ek, ev] = q.eq;
  const [sk, fk, fv] = q.sum;
  if (pm) {
    return {
      n: rows.count({ [ek]: ev }),
      sum: rows.sum(sk, { [fk]: fv }),
      groups: Object.keys(rows.groupCount(q.group)).length,
      bytes: rows.where({ [ek]: ev }).jsonBuffer().length,
    };
  }
  let n = 0;
  let sum = 0;
  const groups = new Set();
  const out = [];
  for (const r of rows) {
    if (r[ek] === ev) (n++, out.push(r));
    if (r[fk] === fv && typeof r[sk] === "number") sum += r[sk];
    if (r[q.group] !== undefined) groups.add(r[q.group]);
  }
  return { n, sum, groups: groups.size, bytes: Buffer.byteLength(JSON.stringify(out)) };
}

if (!isMainThread) {
  const pm = await import("../index.js");
  const { name, mode, handle, rows: cloned } = workerData;
  const d = DATA[name];
  const rows = mode === "copy" ? pm.loadJsonl(d.file) : mode === "share" ? pm.Table.fromShared(handle) : cloned ?? null;
  const answer = work(rows, mode !== "objects", d.q);
  globalThis.gc();
  parentPort.postMessage(answer);
  // keep the data alive until the parent has measured
  globalThis.__keep = rows;
  parentPort.once("message", () => parentPort.close());
} else if (process.argv[2] === "--child") {
  const [name, mode] = process.argv.slice(3);
  const d = DATA[name];
  const pm = await import("../index.js");
  const t0 = performance.now();
  const rows =
    mode === "floor"
      ? null
      : mode === "objects"
        ? readFileSync(d.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : pm.loadJsonl(d.file);
  const handle = mode === "share" ? rows.share() : undefined;
  const workers = Array.from(
    { length: WORKERS },
    () => new Worker(fileURLToPath(import.meta.url), { workerData: { name, mode, handle, rows: mode === "objects" ? rows : undefined } }),
  );
  const answers = await Promise.all(workers.map((w) => new Promise((ok, fail) => (w.once("message", ok), w.once("error", fail)))));
  const readyMs = Math.round(performance.now() - t0);
  const mine = work(rows, mode !== "objects", d.q);
  for (const a of answers) if (JSON.stringify(a) !== JSON.stringify(mine)) throw new Error(`${name} ${mode}: a worker disagreed`);
  global.gc();
  await new Promise((r) => setTimeout(r, SETTLE_S * 1000));
  global.gc();
  const rssMb = process.memoryUsage().rss / 1e6;
  const peakMb = (process.resourceUsage().maxRSS * 1024) / 1e6;
  for (const w of workers) w.postMessage("stop");
  await Promise.all(workers.map((w) => new Promise((r) => w.once("exit", r))));
  const out = { name, mode, rows: rows?.length ?? 0, packed_mb: rows?.nbytes ? +(rows.nbytes / 1e6).toFixed(1) : null };
  console.log(JSON.stringify({ ...out, workers: WORKERS, ready_ms: readyMs, rss_mb: +rssMb.toFixed(1), peak_rss_mb: +peakMb.toFixed(1), answer: mine }));
  process.exit(0);
} else {
  const runs = Number(process.argv[2] ?? 5);
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const all = [];
  const datasets = {};
  for (const [name, d] of Object.entries(DATA)) {
    const out = [];
    for (let k = 0; k < runs; k++)
      for (const mode of d.modes) {
        const load = +loadavg()[0].toFixed(2);
        const r = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--child", name, mode], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${name} ${mode}: ${r.stderr}`);
        const row = { ...JSON.parse(r.stdout.trim().split("\n").at(-1)), run: k + 1, loadavg_at_start: load };
        out.push(row);
        console.error(`${name} ${mode} run ${k + 1}: ${row.rss_mb} MB settled, ${row.peak_rss_mb} MB peak, ready in ${row.ready_ms} ms (load ${load})`);
      }
    const medians = Object.fromEntries(
      d.modes.map((m) => {
        const rs = out.filter((r) => r.mode === m);
        return [m, { rss_mb: median(rs.map((r) => r.rss_mb)), peak_rss_mb: median(rs.map((r) => r.peak_rss_mb)), ready_ms: median(rs.map((r) => r.ready_ms)) }];
      }),
    );
    const sample = out.find((r) => r.rows);
    datasets[name] = { rows: sample.rows, packed_mb: sample.packed_mb, medians };
    all.push(...out);
  }
  const loads = all.map((r) => r.loadavg_at_start);
  const result = {
    what: `records held by the main thread and ${WORKERS} worker threads of one process; process RSS after GC in every thread and ${SETTLE_S} s idle; medians of ${runs} fresh processes per mode`,
    machine: {
      cpu: cpus()[0]?.model,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      date: new Date().toISOString(),
      loadavg_range: [Math.min(...loads), Math.max(...loads)],
    },
    datasets,
    runs: all,
  };
  mkdirSync(here("results"), { recursive: true });
  const path = here(`results/${process.platform}-${process.arch}-share.json`);
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(datasets, null, 2));
  console.log(`wrote ${path}`);
}
