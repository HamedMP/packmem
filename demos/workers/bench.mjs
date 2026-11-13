// Memory and request times of the Workers demo under `wrangler dev`, which runs the Workers runtime (workerd) locally.
// Each run starts a fresh workerd holding N rows as packmem or as a plain array of objects, and measures from outside:
// workerd's resident memory before loading, after loading plus 20 s idle, and after the queries; the first request
// (which builds the data); and medians of repeated /stats and /export requests. Responses must match between modes.
//   node bench.mjs [--dir <worker project>] [--rows 200000,1000000] [--reps 3] [--out results/darwin-arm64.json]
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const DIR = path.resolve(arg("dir", here))
const ROWS = arg("rows", "200000,1000000").split(",").map(Number)
const REPS = Number(arg("reps", 3))
const OUT = path.resolve(here, arg("out", `results/${process.platform}-${process.arch}.json`))
const SETTLE_S = 20
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function descendants(pid) {
  const kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number)
  return kids.flatMap((k) => [k, ...descendantsSafe(k)])
}
const descendantsSafe = (pid) => {
  try {
    return descendants(pid)
  } catch {
    return []
  }
}
const command = (pid) => execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim()
const rssMb = (pid) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024
// wrangler dev runs two workerd processes, a proxy and the one running the Worker; count both, the proxy stays flat
const workerdMb = (pids) => pids.reduce((s, p) => s + rssMb(p), 0)

async function timed(url) {
  const t = performance.now()
  const res = await fetch(url)
  const body = Buffer.from(await res.arrayBuffer())
  if (!res.ok) throw new Error(`${url}: ${res.status} ${body.toString().slice(0, 200)}`)
  return { ms: performance.now() - t, body }
}

async function run(mode, rows, port) {
  const child = spawn("npx", ["wrangler", "dev", "bench-worker.js", "--port", String(port), "--var", `MODE:${mode}`, "--var", `ROWS:${rows}`, "--log-level", "error", "--show-interactive-dev-session=false"], {
    cwd: DIR,
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  })
  const base = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/`)).ok) break
      } catch {}
      if (i > 120) throw new Error("wrangler dev did not start")
      await sleep(500)
    }
    const workerd = descendantsSafe(child.pid).filter((p) => /workerd/.test(command(p)))
    if (!workerd.length) throw new Error("no workerd process found")
    await sleep(3000)
    const floor = workerdMb(workerd)
    const loadavg = os.loadavg()[0]
    const first = await timed(`${base}/stats?country=SE`)
    await sleep(SETTLE_S * 1000)
    const settled = workerdMb(workerd)
    const wasm = JSON.parse((await timed(`${base}/mem`)).body).wasm_mb
    const stats = [], exports = []
    let statsBody, exportBody
    for (let i = 0; i < 30; i++) ({ ms: stats[i], body: statsBody } = await timed(`${base}/stats?country=SE&path=/api`))
    for (let i = 0; i < 10; i++) ({ ms: exports[i], body: exportBody } = await timed(`${base}/export?status=404`))
    const after = workerdMb(workerd)
    const s = JSON.parse(statsBody)
    delete s.packed_mb
    return {
      floor_mb: floor,
      settled_mb: settled,
      held_mb: settled - floor,
      wasm_mb: wasm,
      after_queries_mb: after,
      first_request_ms: first.ms,
      stats_ms: median(stats),
      export_ms: median(exports),
      export_bytes: exportBody.length,
      packed_mb: JSON.parse(first.body).packed_mb,
      stats_digest: createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16),
      export_digest: createHash("sha256").update(exportBody).digest("hex").slice(0, 16),
      workerd_processes: workerd.length,
      loadavg_at_start: loadavg,
    }
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {}
    await sleep(1500)
  }
}

const version = JSON.parse(readFileSync(path.join(DIR, "node_modules/packmem/package.json"), "utf8")).version
const wrangler = JSON.parse(readFileSync(path.join(DIR, "node_modules/wrangler/package.json"), "utf8")).version
const results = []
let port = 8790
for (const rows of ROWS) {
  for (let rep = 0; rep < REPS; rep++) {
    // interleave the modes so drift in machine load hits both
    for (const mode of rep % 2 ? ["plain", "packmem"] : ["packmem", "plain"]) {
      const r = await run(mode, rows, port++)
      console.error(`${mode} ${rows}: held ${r.held_mb.toFixed(1)} MB, wasm ${r.wasm_mb.toFixed(1)} MB, first ${r.first_request_ms.toFixed(0)} ms, stats ${r.stats_ms.toFixed(1)} ms, export ${r.export_ms.toFixed(1)} ms, load ${r.loadavg_at_start.toFixed(1)}`)
      results.push({ mode, rows, rep, ...r })
    }
  }
}
const same = ROWS.every((rows) => {
  const of = (m, k) => new Set(results.filter((r) => r.rows === rows && r.mode === m).map((r) => r[k]))
  return ["stats_digest", "export_digest"].every((k) => {
    const a = of("packmem", k), b = of("plain", k)
    return a.size === 1 && b.size === 1 && [...a][0] === [...b][0]
  })
})
const summary = ROWS.flatMap((rows) =>
  ["plain", "packmem"].map((mode) => {
    const rs = results.filter((r) => r.rows === rows && r.mode === mode)
    const m = (k) => median(rs.map((r) => r[k]))
    return { mode, rows, held_mb: m("held_mb"), wasm_mb: m("wasm_mb"), settled_mb: m("settled_mb"), floor_mb: m("floor_mb"), first_request_ms: m("first_request_ms"), stats_ms: m("stats_ms"), export_ms: m("export_ms"), export_bytes: rs[0].export_bytes, packed_mb: rs[0].packed_mb }
  }),
)
mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(
  OUT,
  JSON.stringify(
    {
      what: "Workers demo under wrangler dev (local workerd): resident memory of all workerd processes and client-side request times, fresh process per run, no forced GC (workerd offers none), so held_mb includes garbage from generating the rows as JavaScript objects; wasm_mb is packmem's WebAssembly memory, which never shrinks",
      packmem: version,
      wrangler,
      machine: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, cores: os.cpus().length },
      settle_s: SETTLE_S,
      reps: REPS,
      responses_identical: same,
      summary,
      runs: results,
    },
    null,
    2,
  ) + "\n",
)
console.error(`wrote ${OUT}; responses identical between modes: ${same}`)
