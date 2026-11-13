// Runs each demo server in baseline and packmem mode, one at a time, and measures memory and latency per endpoint.
// Usage: [FLIGHTS_PG_URL=postgres://...] node bench.mjs [express|nextjs|fastapi ...]     results: results/<platform>-<arch>.json and a markdown table on stdout
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PORT = 3199;
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 20_000);

const SERVERS = {
  express: { cwd: here("../express"), cmd: ["node", "--expose-gc", "src/server.ts"], env: { PORT } },
  nextjs: { cwd: here("../nextjs"), cmd: ["node", "node_modules/next/dist/bin/next", "start", "-p", String(PORT)], env: { NODE_OPTIONS: "--expose-gc" } },
  fastapi: { cwd: here("../fastapi"), cmd: [".venv/bin/uvicorn", "app:app", "--port", String(PORT), "--log-level", "warning"], env: {} },
};

const ENDPOINTS = [
  { name: "page of 50 rows", path: "/api/flights?carrier=UA&min_delay=60&limit=50", reps: 30 },
  { name: "group by dest", path: "/api/stats/by-dest?carrier=UA", reps: 30 },
  { name: "summary", path: "/api/stats/summary?origin=JFK", reps: 30 },
  { name: "export 58,665 rows", path: "/api/flights/export?carrier=UA", reps: 5 },
  { name: "export all 336,776 rows", path: "/api/flights/export", reps: 3 },
];
const CONCURRENT = { name: "8 concurrent exports of 58,665 rows", path: "/api/flights/export?carrier=UA", n: 8 };

/** Resident MB of a process and all its descendants. */
function treeRss(root) {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
  const kids = new Map();
  const rss = new Map();
  for (const line of out.trim().split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    rss.set(pid, kb);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    total += rss.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return total / 1024;
}

function sampler(pid) {
  let peak = 0;
  const tick = () => (peak = Math.max(peak, treeRss(pid)));
  tick();
  const h = setInterval(tick, 40);
  return {
    reset() { peak = treeRss(pid); },
    peak() { tick(); return peak; },
    stop() { clearInterval(h); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
// canonical form so outputs compare across modes and languages (2.0 from Python and 2 from JS parse to the same number)
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const canon = (buf) => createHash("sha1").update(JSON.stringify(sorted(JSON.parse(buf.toString())))).digest("hex").slice(0, 12);

async function fetchBody(path) {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${buf.toString().slice(0, 200)}`);
  return { ms: performance.now() - t0, buf };
}

async function portFree() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/health`);
    return false;
  } catch {
    return true;
  }
}

async function run(framework, mode) {
  if (!(await portFree())) throw new Error(`port ${PORT} is already serving; stop that process first`);
  const s = SERVERS[framework];
  const proc = spawn(s.cmd[0], s.cmd.slice(1), { cwd: s.cwd, env: { ...process.env, ...s.env, MODE: mode }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const t0 = performance.now();
  let health;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`${framework}/${mode} exited: ${stderr}`);
    try { health = JSON.parse((await fetchBody("/api/health")).buf); break; } catch { await sleep(100); }
  }
  const readyMs = performance.now() - t0;
  const mem = sampler(proc.pid);
  await sleep(1000);
  const justLoaded = treeRss(proc.pid);
  // runtimes return freed heap to the OS lazily (V8's memory reducer acts after several idle seconds), so the
  // steady state is measured after a quiet period
  await sleep(SETTLE_MS - 1000);
  const idle = treeRss(proc.pid);
  const result = { framework, mode, rows: health.rows, load_ms: health.load_ms, ready_ms: Math.round(readyMs), rss_after_load_mb: Math.round(justLoaded), idle_rss_mb: Math.round(idle), endpoints: [] };

  for (const e of ENDPOINTS) {
    for (let i = 0; i < 2; i++) await fetchBody(e.path);
    mem.reset();
    const times = [];
    let last;
    for (let i = 0; i < e.reps; i++) { last = await fetchBody(e.path); times.push(last.ms); }
    result.endpoints.push({ name: e.name, path: e.path, median_ms: +median(times).toFixed(2), bytes: last.buf.length, peak_rss_mb: Math.round(mem.peak()), hash: canon(last.buf) });
  }
  mem.reset();
  const t1 = performance.now();
  const bodies = await Promise.all(Array.from({ length: CONCURRENT.n }, () => fetchBody(CONCURRENT.path)));
  result.endpoints.push({ name: CONCURRENT.name, path: CONCURRENT.path, median_ms: +(performance.now() - t1).toFixed(1), bytes: bodies[0].buf.length, peak_rss_mb: Math.round(mem.peak()), hash: canon(bodies[0].buf), wall: true });
  result.peak_rss_mb = Math.max(...result.endpoints.map((e) => e.peak_rss_mb));
  mem.stop();
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await exited;
  } else {
    throw new Error(`${framework}/${mode} exited during the run: ${stderr.slice(-2000)}`);
  }
  return result;
}

const loadBefore = loadavg().map((x) => +x.toFixed(2));
const pick = process.argv.slice(2);
const frameworks = pick.length ? pick : Object.keys(SERVERS);
const results = [];
for (const f of frameworks) {
  for (const mode of ["baseline", "packmem"]) {
    process.stderr.write(`${f} ${mode} ...\n`);
    results.push(await run(f, mode));
  }
}

const machine = { cpu: cpus()[0]?.model, cores: cpus().length, mem_gb: Math.round(totalmem() / 2 ** 30), node: process.version, platform: `${process.platform}-${process.arch}`, date: new Date().toISOString(), loadavg_before: loadBefore, loadavg_after: loadavg().map((x) => +x.toFixed(2)) };
mkdirSync(here("./results"), { recursive: true });
const source = process.env.FLIGHTS_PG_URL ? "postgres" : "file";
machine.source = source;
const file = here(`./results/${process.platform}-${process.arch}${source === "postgres" ? "-postgres" : ""}.json`);
writeFileSync(file, JSON.stringify({ machine, results }, null, 2));

// markdown
const lines = [];
const fmt = (n) => (n >= 100 ? Math.round(n).toString() : n.toFixed(n >= 10 ? 1 : 2));
for (const f of frameworks) {
  const [b, p] = ["baseline", "packmem"].map((m) => results.find((r) => r.framework === f && r.mode === m));
  lines.push(`\n### ${f}\n`);
  lines.push(`| Measure | Baseline | packmem | Change |`, `| --- | --- | --- | --- |`);
  lines.push(`| RSS 1 s after load, MB | ${b.rss_after_load_mb} | ${p.rss_after_load_mb} | ${(b.rss_after_load_mb / p.rss_after_load_mb).toFixed(1)}x less |`);
  lines.push(`| Idle RSS, settled (${SETTLE_MS / 1000} s), MB | ${b.idle_rss_mb} | ${p.idle_rss_mb} | ${(b.idle_rss_mb / p.idle_rss_mb).toFixed(1)}x less |`);
  lines.push(`| Peak RSS during the run, MB | ${b.peak_rss_mb} | ${p.peak_rss_mb} | ${(b.peak_rss_mb / p.peak_rss_mb).toFixed(1)}x less |`);
  lines.push(`| Load, ms | ${b.load_ms} | ${p.load_ms} | |`);
  b.endpoints.forEach((e, i) => {
    const q = p.endpoints[i];
    const same = e.hash === q.hash ? "" : " (OUTPUT DIFFERS)";
    const ratio = e.median_ms / q.median_ms;
    lines.push(`| ${e.name}, ${e.wall ? "wall" : "median"} ms | ${fmt(e.median_ms)} | ${fmt(q.median_ms)} | ${ratio >= 1 ? `${ratio.toFixed(1)}x faster` : `${(1 / ratio).toFixed(1)}x slower`}${same} |`);
  });
}
console.log(`Machine: ${machine.cpu}, ${machine.cores} cores, ${machine.mem_gb} GB, Node ${machine.node}, load average ${machine.loadavg_before[0]} before, ${machine.loadavg_after[0]} after`);
console.log(lines.join("\n"));
console.log(`\nresults: ${file}`);
