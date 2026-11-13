// Every figure on the site comes from the recorded results files in the repository, read at build time.
import "server-only"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>

const ROOT = path.resolve(process.cwd(), "..")
const file = (p: string) => path.join(ROOT, p)
const has = (p: string) => existsSync(file(p))
const json = (p: string): Rec => JSON.parse(readFileSync(file(p), "utf8"))
const jsonl = (p: string): Rec[] =>
  has(p)
    ? readFileSync(file(p), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
/** Results store [median, min, max]. */
const med = (v: number | number[]) => (Array.isArray(v) ? v[0] : v)

export const REPO = "https://github.com/HamedMP/packmem"

export type Bar = { label: string; value: number; hi?: boolean }
export type Pair = { label: string; a: number; b: number }
export type Point = { x: number; a: number; b: number }

// ---------- where memory goes (Linux sandbox, synthetic log) ----------

const heap = jsonl("experiments/results/heap_results.jsonl")
const heapPm = jsonl("experiments/results/packmem_rss.jsonl").find((r) => r.label === "packmem-balanced")!
const RUNTIMES: [string, string][] = [
  ["java-logs", "Java 21, a HashMap per record"],
  ["python-logs", "Python, a dict per record"],
  ["ruby-logs", "Ruby, a Hash per record"],
  ["node-logs", "Node, an object per record"],
  ["redis-logs", "Redis, a hash per record"],
]
export const runtimeMem: Bar[] = [
  ...RUNTIMES.map(([k, label]) => ({ label, value: heap.find((h) => h.label === k)!.resident_anon_mb as number })),
  { label: "packmem", value: heapPm.resident_anon_mb as number, hi: true },
]
export const composition = RUNTIMES.map(([k, label]) => {
  const w = heap.find((h) => h.label === k)!.words_pct
  return { label: label.split(",")[0], parts: [w.zero + w.pointer + w.int8 + w.int16 + w.int32, w.text, w.other] as number[] }
})

// ---------- Python on real data (Mac) ----------

const ds = jsonl("benchmarks/results/mac-m4pro/datasets.jsonl")
export const machineLine: Rec = ds.find((d) => d.machine)?.machine ?? {}
const flights = (v: string) => ds.find((d) => d.variant === v && d.dataset === "flights")!
export const holders = (
  [
    ["list", "List of dicts"],
    ["pandas", "pandas, inferred types"],
    ["pandas_arrow", "pandas, Arrow-backed, inferred types"],
    ["polars", "polars, inferred types"],
    ["packmem", "packmem"],
  ] as const
).map(([k, label]) => ({
  label,
  value: med(flights(k).rss_mb),
  peak: med(flights(k).peak_mb),
  load: med(flights(k).load_s),
  hi: k === "packmem",
}))
const L = flights("list")
const P = flights("packmem")
export const hero = { a: med(L.rss_mb), b: med(P.rss_mb), polars: med(flights("polars").rss_mb) }
export const loads = { list: med(L.load_s), packmem: med(P.load_s), polars: med(flights("polars").load_s) }
const QUERIES: [string, string][] = [
  ["group count by dest", "Group by destination"],
  ["sum air_time", "Sum a column"],
  ["count dep_delay>60", "Count delays over 60 min"],
  ["count carrier=UA", "Count one carrier"],
  ["sum distance where origin=JFK", "Sum with a filter"],
  ["10k random rows as dicts", "10,000 random rows as dicts"],
  ["loop over every row", "Python loop over every row"],
]
export const queries: Pair[] = [
  ...QUERIES.map(([k, label]) => ({ label, a: L.q[k].ms[0], b: P.q[k].ms[0] })),
  { label: "Same loop, lazy rows", a: L.q["loop over every row"].ms[0], b: P.q["loop over every row, lazy rows"].ms[0] },
]
export const loss = {
  loop: { list: L.q["loop over every row"].ms[0] as number, packmem: P.q["loop over every row"].ms[0] as number },
  random: { list: L.q["10k random rows as dicts"].ms[0] as number, packmem: P.q["10k random rows as dicts"].ms[0] as number },
  floatFilter: { pandas: flights("pandas").q["count dep_delay>60"].ms[0] as number, packmem: P.q["count dep_delay>60"].ms[0] as number },
}
const pyLoadsRaw = ds
  .flatMap((d) => [d.loadavg_start, d.loadavg_end])
  .filter(Array.isArray)
  .map((x: number[]) => x[0])
export const pyLoad = pyLoadsRaw.length ? { lo: Math.min(...pyLoadsRaw), hi: Math.max(...pyLoadsRaw) } : null

// ---------- polars tuned for memory ----------

const tunedA = jsonl("benchmarks/results/mac-m4pro/polars_tuned.jsonl")
const tunedB = jsonl("benchmarks/results/mac-m4pro/polars_tuned_decay0.jsonl")
const TUNED_DS: [string, string][] = [
  ["flights", "Flights, 337 thousand rows"],
  ["logs", "Synthetic web log, 2 million rows"],
  ["flights_big", "Flights repeated 10 times, 3.4 million rows"],
]
export const tuned =
  tunedA.length && tunedB.length
    ? TUNED_DS.map(([d, label]) => {
        const one = (v: string) => med(tunedA.find((r) => r.variant === v && r.dataset === d)!.rss_mb)
        const t = tunedB.filter((r) => r.dataset === d && /^polars_.*\+decay0$/.test(r.variant ?? "")).map((r) => med(r.rss_mb))
        return { ds: d, label, list: one("list"), polars: one("polars"), lo: Math.min(...t), hi: Math.max(...t), packmem: one("packmem") }
      })
    : null
export const tunedRatio = tuned && {
  lo: Math.min(...tuned.map((r) => r.lo / r.packmem)),
  hi: Math.max(...tuned.map((r) => r.hi / r.packmem)),
}
export const flightsTuned = tuned?.find((r) => r.ds === "flights") ?? null
export const ipGroup = (() => {
  const logs = jsonl("benchmarks/results/mac-m4pro/logs_2m.jsonl")
  const after = (v: string) => logs.find((r) => r.variant === v)?.q?.["group count by ip"]?.ms?.[0] as number | undefined
  const pol = ["polars", "polars_rechunk", "polars_tuned", "polars_tuned_scan", "polars_parquet"]
    .map((v) => tunedA.find((r) => r.variant === v && r.dataset === "logs")?.q?.["group count by ip"]?.ms?.[0] as number | undefined)
    .filter((x): x is number => x !== undefined)
  const packmem = after("packmem")
  return packmem === undefined || !pol.length ? null : { packmem, list: after("list"), lo: Math.min(...pol), hi: Math.max(...pol) }
})()

// ---------- crossover ----------

export const cross: Point[] = jsonl("benchmarks/results/mac-m4pro/crossover_flights.jsonl").map((r) => ({ x: r.rows, a: r.list.mb, b: r.packmem.mb }))
const lastWorse = cross.filter((c) => c.b >= c.a).at(-1)
const firstBetter = cross.find((c) => c.x > (lastWorse?.x ?? 0) && c.b < c.a)
export const breakEven =
  lastWorse && firstBetter
    ? `At ${lastWorse.x.toLocaleString("en-US")} rows packmem used more memory than the list (${lastWorse.b.toFixed(2)} against ${lastWorse.a.toFixed(2)} MB); from ${firstBetter.x.toLocaleString("en-US")} rows on it used less.`
    : "packmem used less memory than the list at every size measured."

// ---------- tools with one line changed ----------

const apps = jsonl("benchmarks/results/mac-m4pro/apps.jsonl")
const appMed = (prefix: string, kind: string, field: string) => {
  const xs = apps
    .filter((a) => a.run.startsWith(prefix) && a.run.endsWith(`(${kind})`))
    .map((a) => a[field] as number)
    .sort((x, y) => x - y)
  return xs[Math.floor(xs.length / 2)]
}
export const tools = (
  [
    ["sqlite-utils insert", "sqlite-utils: insert a 104 MB JSON array"],
    ["jello flights", "jello: query 104 MB of JSON lines"],
    ["jello nginx", "jello: query 12 MB of nginx logs"],
  ] as const
).map(([p, label]) => ({
  label,
  a: appMed(p, "original", "peak_mb"),
  b: appMed(p, "patched", "peak_mb"),
  ta: appMed(p, "original", "seconds"),
  tb: appMed(p, "patched", "seconds"),
}))

// ---------- web servers ----------

export const FW: [string, string][] = [
  ["express", "Express"],
  ["nextjs", "Next.js"],
  ["fastapi", "FastAPI"],
]
const read = (p: string) => (has(p) ? json(p) : null)
export const demo = read("demos/bench/results/darwin-arm64.json")!
export const demoPg = read("demos/bench/results/darwin-arm64-postgres.json")
export const linuxDemo = read("demos/bench/results/linux-x64.json")
export const linuxDemoPg = read("demos/bench/results/linux-x64-postgres.json")
export const linuxDs = jsonl("benchmarks/results/linux-x86-fast-ci-dev/datasets.jsonl")

const pick = (d: Rec | null, f: string, m: string): Rec | undefined => d?.results.find((r: Rec) => r.framework === f && r.mode === m)
export type Server = { label: string; f: string; a: number; b: number; pa: number; pb: number; la: number; lb: number }
export const serversOf = (d: Rec | null): Server[] =>
  d
    ? FW.flatMap(([f, label]) => {
        const b = pick(d, f, "baseline")
        const p = pick(d, f, "packmem")
        return b && p ? [{ label, f, a: b.idle_rss_mb, b: p.idle_rss_mb, pa: b.peak_rss_mb, pb: p.peak_rss_mb, la: b.load_ms, lb: p.load_ms }] : []
      })
    : []
export const servers = serversOf(demo)
export const serversPg = serversOf(demoPg)
export const endpointNames: string[] = pick(demo, "express", "baseline")!.endpoints.map((e: Rec) => e.name)
export const latency = endpointNames.map((name, i) => ({
  name,
  cells: FW.map(([f]) => ({ a: pick(demo, f, "baseline")!.endpoints[i].median_ms as number, b: pick(demo, f, "packmem")!.endpoints[i].median_ms as number })),
}))
export const allSame = [demo, demoPg].filter(Boolean).every((d) =>
  (d as Rec).results.every((r: Rec) => r.endpoints.every((e: Rec, i: number) => e.hash === pick(d, r.framework, "baseline")!.endpoints[i].hash)),
)

const oneMin = (x: unknown) => (Array.isArray(x) ? (x[0] as number) : (x as number))
const loadsOf = (ds: (Rec | null)[]) =>
  ds
    .filter(Boolean)
    .flatMap((d) => [(d as Rec).machine.loadavg_before, (d as Rec).machine.loadavg_after])
    .map(oneMin)
    .filter((x) => typeof x === "number")
export const serverLoad = (() => {
  const l = loadsOf([demo, demoPg])
  return l.length ? { lo: Math.min(...l), hi: Math.max(...l) } : null
})()
export const linuxLoad = (() => {
  const l = loadsOf([linuxDemo, linuxDemoPg])
  return l.length ? { lo: Math.min(...l), hi: Math.max(...l) } : null
})()
const nodeRuns = [demo, demoPg].filter(Boolean).flatMap((d) => (d as Rec).results.filter((r: Rec) => r.framework !== "fastapi"))
export const earlyExcess = Math.max(0, ...nodeRuns.map((r: Rec) => (r.rss_after_load_mb ?? r.idle_rss_mb) / r.idle_rss_mb - 1))
export const nodeSettled = [...servers, ...serversPg].filter((s) => s.f !== "fastapi").map((s) => s.a / s.b)
export const pgLoadRatio = (f: string) => {
  const s = serversPg.find((x) => x.f === f)
  return s ? s.lb / s.la : null
}

/** Plain loop, random rows and lazy loop for list and packmem on one machine's flights run. */
export const pyAccess = (rows: Rec[]) => {
  const v = (k: string) => rows.find((d) => d.variant === k && d.dataset === "flights")
  const l = v("list")
  const p = v("packmem")
  if (!l || !p) return null
  return {
    loop: { list: l.q["loop over every row"].ms[0] as number, packmem: p.q["loop over every row"].ms[0] as number },
    random: { list: l.q["10k random rows as dicts"].ms[0] as number, packmem: p.q["10k random rows as dicts"].ms[0] as number },
    lazy: p.q["loop over every row, lazy rows"]?.ms?.[0] as number | undefined,
  }
}

export const pyFlights = (rows: Rec[]) => {
  const v = (k: string) => rows.find((d) => d.variant === k && d.dataset === "flights")
  return v("list") && v("packmem") ? { list: med(v("list")!.rss_mb), packmem: med(v("packmem")!.rss_mb) } : null
}

// how long memory takes to settle after loading, per source (node/bench/settle.mjs)
type Settle = { source: string; samples: { at_s: number; rss_mb: number; pooled_pages: number | null }[] }
const settleOf = (p: string) => (read(p) as { runs: Settle[] } | null)?.runs ?? []
export const settleMac = settleOf("node/bench/results/darwin-arm64-settle.json")
export const settleLinux = settleOf("node/bench/results/linux-x64-settle.json")

// Node in-process timings (node/bench/micro.mjs)
const micro = (read("node/bench/results/darwin-arm64.json") as { rows: { name: string; plain_ms: number; packmem_ms: number }[] } | null)?.rows ?? []
const microRow = (name: string) => micro.find((r) => r.name === name) ?? null
export const pgLoadNode = {
  rows: microRow("Load the flights table from Postgres"),
  copy: microRow("Load the flights table from Postgres via COPY"),
}

export const builtOn = new Date().toISOString().slice(0, 10)
