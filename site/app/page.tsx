import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, Cancel01Icon, GithubIcon, MinusSignIcon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Backdrop } from "@/components/site/backdrop"
import { Logo } from "@/components/site/logo"
import { ThemeToggle } from "@/components/site/theme-toggle"
import { CompareBars, Dumbbell, Figure, HBars, LogLines, NumbersTable, Stacked } from "@/components/site/charts"
import { SectionNav, type NavSection } from "@/components/site/section-nav"
import { WorkersDiagram } from "@/components/site/workers-diagram"
import { HowItWorks } from "@/components/site/how-it-works"
import { less, mb, ms, size, speed } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import * as d from "@/lib/data"
import { Code } from "@/components/site/code"
import type { Lang } from "@/lib/highlight"
import { cn } from "@/lib/utils"

const x = (v: number) => `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`
const range = (xs: number[], digits = 1) => {
  const [lo, hi] = [Math.min(...xs).toFixed(digits), Math.max(...xs).toFixed(digits)]
  return lo === hi ? `about ${lo}` : `${lo} to ${hi}`
}

const fastapi = d.servers.find((s) => s.f === "fastapi")
const express = d.servers.find((s) => s.f === "express")
const jello = d.tools[1]
const ml = d.mlLoader
const hf = d.hfDatasets
const share = d.mlShare
const ld = d.loaderDemo
const hl = d.hfLinux
const wk = d.workers?.sizes.at(-1) ?? null
const workersVersion = d.workers?.version
const workersLoad = d.workers ? `${d.workers.load.lo.toFixed(1)} to ${d.workers.load.hi.toFixed(1)}` : ""
const gb = (v: number) => `${(v / 1000).toFixed(1)} GB`
const pyBookkeeping = d.composition.find((c) => c.label === "Python")!.parts[0]

const pdHold = d.holders.find((h) => h.label === "pandas, inferred types")!
const pdArrowHold = d.holders.find((h) => h.label === "pandas, Arrow-backed, inferred types")!
const vsPm = (mbs: number) => `${x(mbs / d.hero.b)} packmem's memory on the flights`
const COMPARE: { feature: string; cells: [Verdict, string?][] }[] = [
  {
    feature: "Use it as a list of dicts or an array of objects",
    cells: [["yes", "index, loop, append, update, sort"], ["no", "rows on request"], ["part", "row by row is slow"], ["no", "immutable tables"]],
  },
  {
    feature: "Small in memory without choosing types by hand",
    cells: [["yes", "encoding picked per chunk"], ["no", vsPm(d.hero.polars)], ["no", vsPm(pdHold.value)], ["no", vsPm(pdArrowHold.value)]],
  },
  {
    feature: "Filters and counts run on compressed data",
    cells: [["yes"], ["part", "on Categorical and Enum, opt-in"], ["part", "on category, opt-in"], ["part", "on dictionary arrays, opt-in"]],
  },
  {
    feature: "Missing keys stay missing when written back as JSON",
    cells: [["yes"], ["no", "become null"], ["no", "become null"], ["no", "become null"]],
  },
  {
    feature: "JSON responses streamed from the columns",
    cells: [["yes", "in chunks, from a filtered view"], ["part", "whole string or file"], ["part", "whole string or file"], ["no", "no JSON writer"]],
  },
  {
    feature: "Python, Node.js and Cloudflare Workers",
    cells: [["yes", "WebAssembly build for Workers"], ["part", "no Workers build"], ["part", "Python only"], ["yes"]],
  },
  {
    feature: "Joins, window functions and expressions",
    cells: [["no", "filter, count, sum, group count"], ["yes"], ["yes"], ["part", "joins and group-by, no windows"]],
  },
  {
    feature: "Multi-threaded loading and queries",
    cells: [["no", `loads ${Math.round(d.loads.packmem / d.loads.polars)}× slower than polars`], ["yes"], ["no"], ["yes"]],
  },
  {
    feature: "Nested lists and objects as typed columns",
    cells: [["part", "kept as JSON text"], ["yes"], ["no", "Python objects"], ["yes"]],
  },
  {
    feature: "Worker processes share one copy",
    cells: [["yes", "open() maps one saved file; Node worker threads share one table"], ["part", "via memory-mapped IPC files"], ["no"], ["yes", "memory-mapped files"]],
  },
  {
    feature: "Parquet and Arrow IPC",
    cells: [["no"], ["yes"], ["yes"], ["yes"]],
  },
]

const NAV: NavSection[] = [
  { id: "why", title: "Where the memory goes", summary: "Parsed records are mostly object headers, pointers and padding, not data." },
  { id: "how", title: "Pack the columns, query them packed", summary: "One encoded column per field; filters and counts read the codes." },
  { id: "results", title: "On real data, in Python", summary: "336,776 flights: 712 MB as a list of dicts, 20 MB in packmem." },
  { id: "servers", title: "Inside a web server", summary: "Express, Next.js and FastAPI holding the same data, with identical responses." },
  { id: "linux", title: "The same benchmarks on Linux", summary: "The Mac results, repeated on a Linux server." },
  { id: "fit", title: "What it is for", summary: "Servers, scripts, training data loaders, edge functions, pipelines." },
  { id: "compare", title: "packmem, polars, pandas and Arrow", summary: "Which to use when, feature by feature." },
  { id: "limits", title: "Where it loses", summary: "Plain loops, random rows, big group-bys, batched Arrow access." },
  { id: "use", title: "Use it", summary: "pip install, npm install, or the Rust crate." },
  { id: "method", title: "How these numbers were made", summary: "Machines, medians, load averages and the results files." },
]

function Section({ id, title, children }: { id?: string; title?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-32 flex-col gap-6">
      {title && <h2 className="text-2xl font-medium tracking-tight">{title}</h2>}
      {children}
    </section>
  )
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p className="text-lg leading-relaxed text-foreground/90 md:text-xl md:leading-relaxed">{children}</p>
}

function Fit({ title, stat, statSub, tag, wide, figure, children }: { title: string; stat?: string; statSub?: string; tag?: string; wide?: boolean; figure?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3", wide && "md:col-span-2")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        {tag && <Badge variant="outline">{tag}</Badge>}
      </div>
      {stat && (
        <div className="flex flex-col">
          <span className="font-mono text-2xl tracking-tight tabular-nums">{stat}</span>
          {statSub && <span className="text-xs text-muted-foreground">{statSub}</span>}
        </div>
      )}
      {figure && <div className="py-1">{figure}</div>}
      <div className={cn("text-sm leading-relaxed text-muted-foreground", wide ? "grid gap-4 md:grid-cols-2 md:gap-10" : "flex flex-col gap-2")}>{children}</div>
    </div>
  )
}

type Verdict = "yes" | "part" | "no"
const VERDICT = {
  yes: { icon: Tick02Icon, label: "Yes", className: "text-foreground" },
  part: { icon: MinusSignIcon, label: "Partly", className: "text-muted-foreground" },
  no: { icon: Cancel01Icon, label: "No", className: "text-muted-foreground/60" },
}
function Cell({ v, note }: { v: Verdict; note?: string }) {
  const { icon, label, className } = VERDICT[v]
  return (
    <div className="flex flex-col gap-1">
      <span className={className}>
        <HugeiconsIcon icon={icon} strokeWidth={2.2} className="size-4" aria-hidden />
        <span className="sr-only">{label}</span>
      </span>
      {note && <span className="text-[11px] leading-snug whitespace-normal text-muted-foreground">{note}</span>}
    </div>
  )
}

const SNIPPETS: Record<"python" | "node" | "rust", { install: string; lang: Lang; code: string }> = {
  python: {
    install: "pip install packmem",
    lang: "python",
    code: `import packmem

# was: rows = [json.loads(line) for line in open("events.jsonl")]
rows = packmem.load_jsonl("events.jsonl")

rows.count(status=404)
rows.group_count("country", path__prefix="/api/")
rows.where(status=200).to_json()`,
  },
  node: {
    install: "npm install packmem",
    lang: "typescript",
    code: `import { loadJsonl } from "packmem"

// was: text.trim().split("\\n").map((l) => JSON.parse(l))
const rows = loadJsonl("events.jsonl")

rows.count({ status: 404 })
rows.groupCount("country", { path: { prefix: "/api/" } })

export function GET() {
  return new Response(rows.where({ status: 200 }).jsonWebStream())
}`,
  },
  rust: {
    install: "cargo add packmem --git https://github.com/HamedMP/packmem",
    lang: "rust",
    code: `use packmem::{Cell, DynTable, Hint, Pred};

let mut t = DynTable::new(Hint::Balanced);
t.append([
    ("carrier", Cell::Str("UA".into())),
    ("distance", Cell::Int(1400)),
]);

let carrier = t.col_index("carrier").unwrap();
let ua = t.select(carrier, &Pred::Eq(Cell::Str("UA".into())));
let miles = t.sum(t.col_index("distance").unwrap(), Some(&ua));`,
  },
}

export default function Page() {
  const heroRatio = d.hero.a / d.hero.b
  const loopSlow = speed(d.loss.loop.list, d.loss.loop.packmem).text
  const randomSlow = speed(d.loss.random.list, d.loss.random.packmem).text
  const linux = d.serversOf(d.linuxDemo)
  const linuxPg = d.serversOf(d.linuxDemoPg)
  const linuxPy = d.pyFlights(d.linuxDs)
  const linuxAccess = d.pyAccess(d.linuxDs)
  // first sample at which memory has dropped below the starting level, per platform, for the Postgres load
  const settleSummary = (runs: typeof d.settleLinux) => {
    const r = runs.find((x) => x.source === "postgres")
    if (!r || r.samples.length < 2) return null
    const first = r.samples[0]
    const settledIdx = r.samples.findIndex((s) => s.rss_mb < first.rss_mb * 0.75)
    if (settledIdx < 1) return null
    return { early: first.rss_mb, lateBefore: r.samples[settledIdx - 1].at_s, settled: r.samples[settledIdx].rss_mb, settledAt: r.samples[settledIdx].at_s }
  }
  const pgSettle = (() => {
    const linux = settleSummary(d.settleLinux)
    const mac = settleSummary(d.settleMac)
    return linux && mac ? { linux, mac } : null
  })()
  const ql = d.queries
  const qmax = Math.max(...ql.flatMap((q) => [q.a, q.b]))

  return (
    <>
      <Backdrop />
      <SectionNav sections={NAV} />
      <div className="pointer-events-none fixed inset-0 z-[1] bg-background/85 md:bg-transparent md:bg-linear-to-r md:from-background md:from-30% md:via-background/70 md:via-45% md:to-transparent md:to-62%" />

      <header className="fixed inset-x-0 top-0 z-20 flex items-center justify-between px-5 py-6 md:px-12 md:py-8">
        <a href="#top" aria-label="packmem, back to the top">
          <Logo />
        </a>
        <nav className="flex items-center gap-2">
          <Button variant="secondary" size="lg" className="bg-secondary/70 backdrop-blur" nativeButton={false} render={<Link href="/blog/" />}>
            Blog
          </Button>
          <Button variant="secondary" size="lg" className="hidden bg-secondary/70 backdrop-blur sm:inline-flex" nativeButton={false} render={<a href="#results" />}>
            Results
          </Button>
          <Button variant="secondary" size="lg" className="gap-2 bg-secondary/70 font-mono text-xs backdrop-blur" nativeButton={false} render={<a href={d.REPO} />}>
            <HugeiconsIcon icon={GithubIcon} strokeWidth={2} data-icon="inline-start" />
            v0.2.0
          </Button>
          <ThemeToggle />
        </nav>
      </header>

      <main id="top" className="fade-top fixed inset-0 z-10 overflow-y-auto scroll-smooth">
        <div className="flex max-w-[44rem] flex-col gap-24 px-5 pt-[24vh] pb-32 md:px-12">
          {/* ---------- hero ---------- */}
          <Section>
            <h1 className="text-[1.75rem] leading-tight font-medium tracking-tight md:text-[2rem]">
              Most of a program&apos;s memory is not its data.
            </h1>
            <p className="text-[1.75rem] leading-tight font-medium tracking-tight text-muted-foreground md:text-[2rem]">
              packmem keeps your records as packed columns that your code can still index, loop over, update and query,
              without unpacking anything.
            </p>
            <Lead>
              336,776 real flights take {mb(d.hero.a)} as a Python list of dicts. In packmem they take {mb(d.hero.b)}, from
              changing one line.
            </Lead>
            <div className="grid grid-cols-3 border-y">
              {[
                [x(heroRatio), "less memory than a list of dicts"],
                [d.flightsTuned ? `${(d.flightsTuned.lo / d.flightsTuned.packmem).toFixed(1)}×` : "–", "less than polars tuned for memory"],
                [x(d.servers[2].a / d.servers[2].b), "smaller FastAPI server at rest"],
              ].map(([v, l], i) => (
                <div key={l} className={i ? "border-l py-5 pl-4" : "py-5 pr-4"}>
                  <div className="text-3xl font-medium tracking-tight md:text-4xl">{v}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{l}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 border-b text-sm">
              {["Python 3.10+", "Node 20+", "Rust core", "Postgres loaders"].map((t, i) => (
                <div key={t} className={`flex items-center gap-2 py-3 ${i % 2 ? "border-l pl-4" : ""} ${i < 2 ? "border-b" : ""}`}>
                  <span className="size-1.5 rounded-[2px] bg-primary" />
                  {t}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" nativeButton={false} render={<a href="#use" />}>
                Use it
              </Button>
              <Button size="lg" variant="outline" className="bg-background/40 backdrop-blur" nativeButton={false} render={<a href="#results" />}>
                See the numbers
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
              </Button>
            </div>
          </Section>

          {/* ---------- why ---------- */}
          <Section id="why" title="Where the memory goes">
            <Lead>
              Parse a file into objects and every value gets wrapped: an object header, a pointer to it, a hash slot for its
              key, padding to the next boundary. The same 75.5 MB log grew 2.7 to 9 times in five runtimes, and most of the
              words were zeros, pointers and small counters.
            </Lead>
            <Figure title="The same 75.5 MB of web logs, held by six runtimes" sub="Resident memory after loading 300,000 records, one process each." note="2-core Linux sandbox, synthetic web log, an earlier build than the rest of this page.">
              <HBars rows={d.runtimeMem} />
              <NumbersTable head={["Holder", "Resident MB"]} rows={d.runtimeMem.map((r) => [r.label, r.value.toFixed(1)])} />
            </Figure>
            <Figure title="What those bytes are" sub="Each 8-byte word of a 64 MB sample of the heap, classified." note="Java stores pointers as 32-bit values, so its pointer share is understated; Node's text includes strings awaiting garbage collection.">
              <Stacked rows={d.composition} names={["Bookkeeping: zeros, pointers, small integers", "Text", "Other"]} />
              <NumbersTable head={["Runtime", "Bookkeeping %", "Text %", "Other %"]} rows={d.composition.map((r) => [r.label, ...r.parts.map((p) => p.toFixed(1))])} />
            </Figure>
            <blockquote className="border-l-2 pl-5 text-lg text-muted-foreground italic">
              Operating systems already compress memory pages, but a compressed page has to be decompressed before any byte in
              it is read. The larger saving is not to create the overhead at all.
            </blockquote>
          </Section>

          {/* ---------- how ---------- */}
          <Section id="how" title="Pack the columns, query them packed">
            <Lead>
              Each field becomes one column, and every 16,384-row chunk of it gets an encoding picked from a sample of its
              values, so a column whose values drift changes encoding as it goes. Every encoding keeps fast
              access to a single value, so nothing is unpacked in bulk, and filters run on the encoded form.
            </Lead>
            <Figure title="From a list of dicts to packed columns" sub="Six real rows of the flights data. The encodings and bit widths are the ones packmem picks for the full table.">
              <HowItWorks listMb={d.hero.a} packedMb={d.hero.b} records={336_776} />
            </Figure>
            <div className="grid gap-6 sm:grid-cols-2">
              {[
                ["Dictionary", "carrier has 16 distinct values in 336,776 rows: store them once, and a 4-bit code per row. Counting UA compares codes. A dictionary is kept only where it is smaller than offsets."],
                ["Frame of reference", "arr_delay is stored as the offset from its minimum in the narrowest width that fits its chunk. Sums and range filters run on the narrow codes."],
                ["Constants, runs and blocks", "A column with one value (year) is stored once. Long runs become one value and an end. Sorted values get a minimum per block, so a range count is two binary searches."],
                ["FSST strings", "Frequent substrings become one-byte codes, and each string still decodes on its own."],
              ].map(([h, t]) => (
                <div key={h} className="flex flex-col gap-1.5">
                  <h3 className="font-medium">{h}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t}</p>
                </div>
              ))}
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">
              None of these encodings is new. Analytical databases use them, notably{" "}
              <a className="underline underline-offset-4" href="https://www.vldb.org/pvldb/vol16/p2148-kuschewski.pdf">BtrBlocks</a> and{" "}
              <a className="underline underline-offset-4" href="https://github.com/spiraldb/vortex">Vortex</a>, and the string scheme is{" "}
              <a className="underline underline-offset-4" href="https://www.vldb.org/pvldb/vol13/p2649-boncz.pdf">FSST</a>. What packmem adds is
              putting them behind the containers ordinary programs already use: a list of dicts, an array of objects.
            </p>
          </Section>

          {/* ---------- results ---------- */}
          <Section id="results" title="On real data, in Python">
            <Lead>
              The flight data is the public nycflights13 set: 19 columns of numbers, short strings and timestamps, with missing
              values. packmem used less memory than pandas and polars with inferred types
              {d.tunedRatio && `, and ${d.tunedRatio.lo.toFixed(1)} to ${d.tunedRatio.hi.toFixed(1)} times less than polars tuned for memory`},
              while still behaving like a list.
            </Lead>
            <Figure title="336,776 real flights in Python" sub="Resident memory after loading 104 MB of JSON lines. Median of 5 fresh processes.">
              <HBars rows={d.holders} />
              <NumbersTable head={["Holder", "Resident MB", "Peak MB", "Load s"]} rows={d.holders.map((r) => [r.label, r.value.toFixed(1), r.peak.toFixed(1), r.load.toFixed(2)])} />
            </Figure>
            {d.tuned && (
              <Figure title="Against polars tuned for memory" sub="Enum strings, the smallest integer types, a rechunk, and the allocator told to return freed memory; the best of three loading setups." note="Tuned polars needs the schema known and set by hand.">
                <div className="flex flex-col gap-5">
                  {d.tuned.map((r) => (
                    <div key={r.ds} className="flex flex-col gap-2">
                      <span className="font-mono text-xs tracking-wide text-muted-foreground uppercase">{r.label}</span>
                      <HBars
                        rows={[
                          { label: "polars, inferred types", value: r.polars },
                          { label: "polars, tuned", value: r.lo },
                          { label: "packmem", value: r.packmem, hi: true },
                        ]}
                      />
                    </div>
                  ))}
                </div>
                <NumbersTable head={["Dataset", "List MB", "polars MB", "tuned polars MB", "packmem MB"]} rows={d.tuned.map((r) => [r.label, r.list.toFixed(0), r.polars.toFixed(0), `${r.lo.toFixed(0)} to ${r.hi.toFixed(0)}`, r.packmem.toFixed(0)])} />
              </Figure>
            )}
            <Figure title="Queries: list of dicts against packmem" sub="Milliseconds, log scale; further left is faster." note="The slower rows are the honest cost: plain loops rebuild a dict per record. Lazy rows decode only the fields a loop reads.">
              <Dumbbell rows={ql} unit="ms" log lo={0.1} hi={Math.max(1000, qmax)} ticks={[0.1, 1, 10, 100]} aName="List of dicts" verdict="time" />
              <NumbersTable head={["Query", "List ms", "packmem ms", "Change"]} rows={ql.map((q) => [q.label, q.a.toFixed(2), q.b.toFixed(2), speed(q.a, q.b).text])} />
            </Figure>
            <Figure title="When it starts to pay off" sub="Resident memory against rows loaded, both axes log scale." note={`${d.breakEven} Below about 10,000 rows most of what packmem holds is load buffers, not data.`}>
              <LogLines points={d.cross} aName="List of dicts" xLo={100} xHi={1_000_000} yLo={0.1} yHi={3000} xTicks={[100, 1000, 10000, 100000, 1000000]} yTicks={[0.1, 1, 10, 100, 1000]} />
              <NumbersTable head={["Rows", "List MB", "packmem MB"]} rows={d.cross.map((c) => [c.x.toLocaleString("en-US"), c.a.toFixed(2), c.b.toFixed(2)])} />
            </Figure>
            <Figure title="Open-source tools, one line changed" sub="Peak memory of the whole process. jello printed identical results in both versions.">
              <Dumbbell rows={d.tools} unit="mb" lo={0} hi={2000} ticks={[0, 1000, 2000]} aName="Original" bName="One line changed" verdict="memory" />
              <NumbersTable head={["Tool and task", "Peak MB before", "Peak MB after", "s before", "s after"]} rows={d.tools.map((t) => [t.label, t.a.toFixed(0), t.b.toFixed(0), t.ta.toFixed(2), t.tb.toFixed(2)])} />
            </Figure>
          </Section>

          {/* ---------- servers ---------- */}
          <Section id="servers" title="Inside a web server">
            <Lead>
              Load a dataset at start-up, then serve filtered pages, aggregates and exports from memory. The same five routes in
              Express, Next.js and FastAPI, switched between plain objects and packmem with one environment variable.
              {d.allSame && " Every response was identical between the two."}
            </Lead>
            <Figure title="Loaded from a JSON-lines file" sub="Settled resident memory of the whole server, after a garbage collection and 20 seconds idle.">
              <Dumbbell rows={d.servers} unit="mb" lo={0} hi={800} ticks={[0, 200, 400, 600, 800]} aName="Plain objects" verdict="memory" />
              <NumbersTable head={["Framework", "Settled MB before", "after", "Peak MB before", "after"]} rows={d.servers.map((s) => [s.label, s.a, s.b, s.pa, s.pb])} />
            </Figure>
            {d.serversPg.length > 0 && (
              <Figure title="Loaded from Postgres" sub="node-postgres and psycopg rows against packmem's cursor loaders, same fetch pattern." note={`In Node, loading through packmem took ${range(["express", "nextjs"].map((f) => d.pgLoadRatio(f) ?? 1))} times as long as the driver's own rows: rows cross into the native code as text.`}>
                <Dumbbell rows={d.serversPg} unit="mb" lo={0} hi={800} ticks={[0, 200, 400, 600, 800]} aName="Plain objects" verdict="memory" />
                <NumbersTable head={["Framework", "Settled MB before", "after", "Load ms before", "after"]} rows={d.serversPg.map((s) => [s.label, s.a, s.b, s.la, s.lb])} />
              </Figure>
            )}
            <Figure title="Response times" sub="Medians from a client on the same machine; the concurrent row is wall time.">
              <div className="overflow-x-auto">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      {d.FW.map(([, l]) => (
                        <TableHead key={l} className="text-right">
                          {l}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.latency.map((row) => (
                      <TableRow key={row.name}>
                        <TableCell className="text-muted-foreground">{row.name}</TableCell>
                        {row.cells.map((c, i) => {
                          const s = speed(c.a, c.b)
                          return (
                            <TableCell key={i} className="text-right tabular-nums">
                              <div>{ms(c.a)} → {ms(c.b)}</div>
                              <div className={s.good === false ? "text-destructive" : s.good ? "font-medium" : "text-muted-foreground"}>{s.text}</div>
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Figure>
            <Lead>
              Python gets both: a tenth of the memory and queries tens of times faster than loops over dicts. In Node the gain is
              mainly memory and is largest at peak; at rest it is {range(d.nodeSettled)} times, because V8 already stores objects of
              one shape compactly.
            </Lead>
          </Section>

          {/* ---------- linux ---------- */}
          {linux.length > 0 && (
            <Section id="linux" title="The same benchmarks on Linux">
              <Lead>
                Everything above ran on an Apple M4 Pro. The same code, data and scripts also ran on a Linux server:{" "}
                {d.linuxDemo!.machine.cpu}, Ubuntu 24.04{d.linuxLoad && `, load average ${d.linuxLoad.lo.toFixed(1)} to ${d.linuxLoad.hi.toFixed(1)}`}. On Linux
                memory is the resident set size; on macOS the Python figures are the physical footprint and the server figures the
                resident size of the process tree, so compare ratios rather than megabytes. Every query answer matched the Mac&apos;s.
              </Lead>
              {linuxPy && (
                <p className="text-base leading-relaxed text-foreground/90">
                  In Python the gap is wider on Linux: the flights take {mb(linuxPy.packmem)} against {mb(d.hero.b)} on the Mac. About{" "}
                  {Math.round(d.hero.b - linuxPy.packmem)} MB of what packmem holds on macOS is load buffers the macOS allocator keeps after loading; glibc returns them.
                  {linuxAccess &&
                    ` The costs are wider too: a plain loop over every row is ${speed(linuxAccess.loop.list, linuxAccess.loop.packmem).text} than the list, random rows ${speed(linuxAccess.random.list, linuxAccess.random.packmem).text}${linuxAccess.lazy ? `, and lazy rows ${Math.abs(linuxAccess.lazy / linuxAccess.loop.list - 1) < 0.1 ? "only match" : speed(linuxAccess.loop.list, linuxAccess.lazy).text.replace("about the same", "match")} the list (${ms(linuxAccess.lazy)} against ${ms(linuxAccess.loop.list)})` : ""}.`}
                </p>
              )}
              <p className="text-base leading-relaxed text-foreground/90">
                Node saves less on Linux than on the Mac. The Postgres rows on Linux need a caveat:
                {pgSettle
                  ? ` loading from Postgres leaves freed V8 heap pages that V8 keeps for a while before returning them. A table loaded from Postgres on Linux held ${pgSettle.linux.early} MB until ${pgSettle.linux.lateBefore} s after loading and ${pgSettle.linux.settled} MB by ${pgSettle.linux.settledAt} s (on the Mac, ${pgSettle.mac.early} MB falling to ${pgSettle.mac.settled} MB within ${pgSettle.mac.settledAt} s). The servers were measured at 20 seconds, before that point on Linux, so their Postgres figures above are an upper bound.`
                  : " loaded from Postgres, the Node servers on Linux kept more memory at rest than when loaded from the file."}
              </p>
              <Figure title="A web server holding the dataset, on Linux" sub="Settled resident memory after loading the flights from the file.">
                <Dumbbell rows={linux} unit="mb" lo={0} hi={800} ticks={[0, 200, 400, 600, 800]} aName="Plain objects" verdict="memory" />
                <NumbersTable head={["Framework", "Settled MB before", "after", "Peak MB before", "after"]} rows={linux.map((s) => [s.label, s.a, s.b, s.pa, s.pb])} />
              </Figure>
              <div className="overflow-x-auto rounded-xl border bg-card/70 p-5 backdrop-blur-sm">
                <Table className="text-xs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Baseline → packmem</TableHead>
                      <TableHead className="text-right">macOS, M4 Pro</TableHead>
                      <TableHead className="text-right">Linux, Ryzen 9</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {linuxPy && (
                      <TableRow>
                        <TableCell>Python, flights in a list of dicts</TableCell>
                        <TableCell className="text-right tabular-nums">{mb(d.hero.a)} → {mb(d.hero.b)} ({x(d.hero.a / d.hero.b)})</TableCell>
                        <TableCell className="text-right tabular-nums">{mb(linuxPy.list)} → {mb(linuxPy.packmem)} ({x(linuxPy.list / linuxPy.packmem)})</TableCell>
                      </TableRow>
                    )}
                    {linux.map((l) => {
                      const m = d.servers.find((s) => s.f === l.f)
                      return (
                        <TableRow key={l.f}>
                          <TableCell>{l.label} server at rest, from the file</TableCell>
                          <TableCell className="text-right tabular-nums">{m ? `${m.a} → ${m.b} MB (${x(m.a / m.b)})` : "–"}</TableCell>
                          <TableCell className="text-right tabular-nums">{`${l.a} → ${l.b} MB (${x(l.a / l.b)})`}</TableCell>
                        </TableRow>
                      )
                    })}
                    {linuxPg.map((l) => {
                      const m = d.serversPg.find((s) => s.f === l.f)
                      return (
                        <TableRow key={`pg-${l.f}`}>
                          <TableCell>{l.label} server at rest, from Postgres</TableCell>
                          <TableCell className="text-right tabular-nums">{m ? `${m.a} → ${m.b} MB (${x(m.a / m.b)})` : "–"}</TableCell>
                          <TableCell className="text-right tabular-nums">{`${l.a} → ${l.b} MB (${x(l.a / l.b)})`}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </Section>
          )}

          {/* ---------- fit ---------- */}
          <Section id="fit" title="What it is for">
            <Lead>
              packmem is for programs that hold many records in memory and keep using them as records: looking them up,
              filtering, counting, sending them back out as JSON. That shape is everywhere, and in most of those places
              memory, not processor time, decides the size of the machine, how many workers fit on it, and whether the data
              can stay in the process at all.
            </Lead>
            <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
              {fastapi && express && (
                <Fit
                  title="Servers that keep a dataset in memory"
                  stat={`${mb(fastapi.a)} → ${mb(fastapi.b)}`}
                  statSub="A whole FastAPI server, settled, holding the flights"
                  figure={
                    <CompareBars
                      unit="mb"
                      rows={d.servers.flatMap((sv) => [
                        { label: `${sv.label}, plain objects`, value: sv.a },
                        { label: `${sv.label}, packmem`, value: sv.b, hi: true },
                      ])}
                    />
                  }
                >
                  <p>
                    Load at start-up, then serve filtered pages, counts and exports from memory. Express settled at {mb(express.b)} instead
                    of {mb(express.a)}, and every response was identical to the plain version. A smaller footprint is a smaller instance,
                    or more replicas on the same one.
                  </p>
                </Fit>
              )}
              <Fit
                title="Scripts and command-line tools"
                stat={`${mb(jello.a)} → ${mb(jello.b)}`}
                statSub="Peak memory, jello querying 104 MB of JSON lines"
                figure={
                  <CompareBars
                    unit="mb"
                    rows={d.tools.flatMap((t, i) => {
                      const name = ["sqlite-utils, 104 MB JSON", "jello, 104 MB JSON lines", "jello, 12 MB of logs"][i] ?? t.label
                      return [
                        { label: name, value: t.a },
                        { label: `${name}, packmem`, value: t.b, hi: true },
                      ]
                    })}
                  />
                }
              >
                <p>
                  Tools that parse a whole file into a list and then query it. jello also finished in {jello.tb.toFixed(2)} s instead
                  of {jello.ta.toFixed(2)} s. Not every tool gets faster: sqlite-utils used less memory but more time.
                </p>
              </Fit>
              {ml && (
                <Fit
                  wide
                  title="Training data for LLMs and vision-language models"
                  tag="Indicative"
                  stat={`${gb(ml.list.forkPeakMb)} → ${gb(ml.packmem.forkPeakMb)}`}
                  statSub="Parent and 4 data-loader workers, one full shuffled epoch"
                  figure={
                    <div className="md:w-1/2 md:pr-5">
                      <CompareBars
                        unit="size"
                        caption="Qwen3-VL loader, 4 workers, Apple M4 Pro"
                        rows={[
                          { label: "List of dicts, fork", value: ml.list.forkPeakMb },
                          { label: "packmem, fork", value: ml.packmem.forkPeakMb, hi: true },
                          ...(share
                            ? [
                                { label: "packmem, spawn, pickled", value: share.pickled.peakMb },
                                { label: "packmem share() (0.1.2), spawn", value: share.shared.peakMb, hi: true },
                              ]
                            : []),
                        ]}
                      />
                    </div>
                  }
                >
                  <p>
                    A fine-tuning loader keeps the annotation list in the main process and gives every worker a copy. We swapped that list
                    for packmem in Qwen3-VL&apos;s fine-tuning dataset class and ran it on the real {ml.list.records.toLocaleString("en-US")}-record
                    LLaVA mix on an Apple M4 Pro. With spawn workers the first batch arrived in {ml.packmem.spawnFirstBatchS.toFixed(1)} s
                    instead of {ml.list.spawnFirstBatchS.toFixed(1)} s, because the pickled dataset is {mb(ml.packmem.pickleMb)} instead
                    of {mb(ml.list.pickleMb)}.
                    {share &&
                      ` In 0.1.2, rows.share() writes the table to a file once, and each spawn worker loads it from there instead of receiving a pickle: parent and workers peaked at ${gb(share.shared.peakMb)} instead of ${gb(share.pickled.peakMb)}, and the first batch arrived in ${share.shared.firstBatchS.toFixed(1)} s instead of ${share.pickled.firstBatchS.toFixed(1)} s.`}
                  </p>
                  <p className="text-xs leading-relaxed">
                    Annotations only: no images, model or GPU. Building the dataset took {(ml.packmem.buildS / ml.list.buildS).toFixed(1)} times
                    as long, because conversation turns are stored as JSON text. None of the patched repositories has tests for the patched
                    code, so correctness rests on every record equalling json.load&apos;s output and on identical batch hashes. This is our
                    patch, not an upstream integration.{share && " share() was measured on 20,000 random samples with 4 spawn workers; each worker still holds its own copy of the packed table."}{" "}
                    <a className="underline underline-offset-4" href={`${d.REPO}/tree/main/benchmarks/ml_swaps`}>Patches, harness and raw outputs</a>.
                  </p>
                </Fit>
              )}
              {hl && (
                <Fit
                  wide
                  title="Against Hugging Face datasets"
                  tag="0.2.0, verified on Linux"
                  stat={`${mb(hl.forkserver.hf.machineMb)} → ${mb(hl.forkserver.open.machineMb)}`}
                  statSub={`Whole-machine memory, ${hl.workers} DataLoader workers over ${hl.records.toLocaleString("en-US")} LLaVA records: memory-mapped Arrow against packmem.open()`}
                  figure={
                    <div className="flex flex-col gap-6">
                    <WorkersDiagram left="List or pickled table: a copy per worker" right="packmem.open(): one file for all" />
                    <CompareBars
                      caption={`Peak memory of the parent and its ${hl.workers} forkserver workers together (PSS), Linux. A plain list took ${size(hl.forkserver.list.machineMb)}, and its first batch ${hl.forkserver.list.firstBatchS.toFixed(0)} s.`}
                      rows={[
                        { label: "Hugging Face datasets, memory-mapped Arrow", value: hl.forkserver.hf.machineMb },
                        { label: "packmem 0.2.0 share()", value: hl.forkserver.share.machineMb, hi: true },
                        { label: "packmem 0.2.0 save() + open()", value: hl.forkserver.open.machineMb, hi: true },
                      ]}
                    />
                    </div>
                  }
                >
                  <div className="flex flex-col gap-2">
                    <p className="font-medium text-foreground">
                      {Math.round((1 - hl.forkserver.open.machineMb / hl.forkserver.hf.machineMb) * 100)}% less memory than memory-mapped Arrow, from a file{" "}
                      {(hl.fileMb.arrow / hl.fileMb.packmem).toFixed(1)} times smaller.
                    </p>
                    <p>
                      Save the packed table once, then <code className="font-mono text-xs">packmem.open()</code> it: the parent and every worker
                      read one mapped file, as with Hugging Face datasets. Above a loader serving no data, packmem added{" "}
                      {mb(hl.forkserver.open.extraMb)} ({mb(hl.forkserver.share.extraMb)} with <code className="font-mono text-xs">share()</code>)
                      against {mb(hl.forkserver.hf.extraMb)} for datasets and {size(hl.forkserver.list.extraMb)} for a list. Most of
                      datasets&apos; extra is not data: each worker imports the library, {mb(hl.importMb.datasets)} a process against{" "}
                      {mb(hl.importMb.packmem)} for packmem. The file is {mb(hl.fileMb.packmem)} against a {mb(hl.fileMb.arrow)} Arrow cache, so
                      less page cache per machine, with no schema to declare. With fork workers the machine held {mb(hl.fork.open.machineMb)} against{" "}
                      {mb(hl.fork.hf.machineMb)}, and the first batch arrived in {hl.forkserver.open.firstBatchS.toFixed(1)} s against{" "}
                      {hl.forkserver.hf.firstBatchS.toFixed(1)} s and {hl.forkserver.list.firstBatchS.toFixed(0)} s for a list.
                    </p>
                    {ld?.spawn.open020 && ld.spawn.hf && (
                      <p>
                        Our fine-tuning loader demo shows the same on a Mac with spawn workers: {mb(ld.spawn.open020.aboveMb)} above the floor
                        with packmem against {mb(ld.spawn.hf.aboveMb)} with datasets.{" "}
                        <a className="underline underline-offset-4" href={`${d.REPO}/tree/main/demos/finetune-loader`}>The demo and its results</a>.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="font-medium text-foreground">Where datasets still wins.</p>
                    <p>
                      Its batched access (<code className="font-mono text-xs">ds[i:i+64]</code>, <code className="font-mono text-xs">ds.iter()</code>)
                      was about twice as fast in our earlier comparison, its compressed Parquet source is smaller at rest, and parsing JSON
                      into packmem is slower than <code className="font-mono text-xs">json.load</code> the first time.
                    </p>
                    <p className="text-xs leading-relaxed">
                      packmem {hl.versions.packmem} and datasets {hl.versions.datasets} from PyPI, torch {hl.versions.torch}, one shared Linux server,
                      medians of 3 runs per arm. Annotations only: no images, model or GPU. Memory held to within about 1 MB across runs; the
                      server&apos;s load was 10 to 27, so timings are indicative. share() keeps its file in /dev/shm, which is RAM; the
                      whole-machine figure counts the pages the processes touched.
                      {hl.forkserver.sameBatches && " Every variant produced identical batches."}{" "}
                      <a className="underline underline-offset-4" href={`${d.REPO}/blob/main/benchmarks/ml_swaps/hf-datasets/pypi-0.2.0/RESULT_0.2.0.md`}>Write-up, scripts and raw results</a>.
                    </p>
                  </div>
                </Fit>
              )}
              {wk ? (
                <Fit
                  title="Edge functions and small containers"
                  stat={`${mb(wk.plain.held_mb)} → ${mb(wk.packmem.wasm_mb)}`}
                  statSub={`${wk.rows.toLocaleString("en-US")} rows held in a Worker, as objects and in packmem's WebAssembly memory`}
                  figure={
                    <CompareBars
                      rows={[
                        { label: "Array of objects", value: wk.plain.held_mb },
                        { label: "Whole runtime with packmem, before garbage collection", value: wk.packmem.held_mb },
                        { label: "packmem's WebAssembly memory", value: wk.packmem.wasm_mb, hi: true },
                      ]}
                    />
                  }
                >
                  <p>
                    A Cloudflare Worker gets 128 MB, WebAssembly included, and <code className="font-mono text-xs">packmem/wasm</code> runs
                    the same table, queries and streamed JSON there. In the Workers runtime run locally by wrangler, the rows as objects grew
                    it by {mb(wk.plain.held_mb)}; packmem held them in {mb(wk.packmem.wasm_mb)} of WebAssembly memory
                    ({mb(wk.packmem.packed_mb ?? 0)} packed). A filtered group count took {ms(wk.packmem.stats_ms)} against{" "}
                    {ms(wk.plain.stats_ms)}, and exports were level.
                  </p>
                  <p className="text-xs leading-relaxed">
                    Building the table took {Math.round(wk.packmem.first_request_ms / wk.plain.first_request_ms)} times as long, because rows go
                    from objects through JSON into WebAssembly, and that leaves garbage: the runtime as a whole grew {mb(wk.packmem.held_mb)}.
                    Local workerd neither collects garbage on demand nor enforces the 128 MB limit, so this is not a capacity test on
                    Cloudflare. packmem {workersVersion}, load average {workersLoad}.{" "}
                    <a className="underline underline-offset-4" href={`${d.REPO}/tree/main/demos/workers`}>Script and results</a>.
                  </p>
                </Fit>
              ) : (
                <Fit title="Edge functions and small containers">
                  <p>
                    A Cloudflare Worker gets 128 MB, WebAssembly included. <code className="font-mono text-xs">packmem/wasm</code> runs the
                    same table, queries and streamed JSON there, so a reference dataset can ship inside the Worker instead of sitting behind
                    another network hop.
                  </p>
                </Fit>
              )}
              <Fit title="Data processing before the dataframe">
                <p>
                  Rows from a database cursor, a CSV file or an API arrive as records, and most pipeline code handles them as records.
                  <code className="font-mono text-xs"> from_cursor</code>, <code className="font-mono text-xs">read_csv</code> and, in Node,{" "}
                  <code className="font-mono text-xs">fromPgCopy</code> pack them without a dict or object per row
                  {d.pgLoadNode.copy && `; COPY loading in Node took ${ms(d.pgLoadNode.copy.packmem_ms)} against ${ms(d.pgLoadNode.copy.plain_ms)} for plain node-postgres rows`}.
                  When a step turns into analytics over millions of rows, a dataframe is the better tool.
                </p>
              </Fit>
            </div>

            <div className="flex flex-col gap-4 border-l-2 pl-5">
              <h3 className="text-lg font-medium">What changes when the scaffolding goes</h3>
              <p className="leading-relaxed text-foreground/90">
                Most work on memory makes data smaller at rest: compressed files, compressed pages, compact formats on the wire. What
                remains is the scaffolding a running program builds around every value. In the Python heap we sampled,{" "}
                {Math.round(pyBookkeeping)}% of the words were zeros, pointers and small integers. packmem never builds it, and the data
                stays usable as it is.
              </p>
              <p className="leading-relaxed text-foreground/90">
                That moves decisions that are usually settled by buying hardware: the instance a service needs to keep its dataset in
                memory, whether a lookup table has to move out to Redis, whether a dataset fits in an edge function at all.
              </p>
              {ml && (
                <p className="leading-relaxed text-foreground/90">
                  For training jobs it matters more, because host memory is multiplied by every process that holds the data. Fork workers
                  should share the parent&apos;s memory, but Python&apos;s reference counts write to every object a worker touches, so the
                  shared pages get copied anyway: each fork worker above peaked at {gb(ml.list.forkWorkerMb)} with the list and{" "}
                  {mb(ml.packmem.forkWorkerMb)} with packmem, whose columns are a few large buffers rather than millions of objects.
                  On one node with eight ranks of four workers each, that is thirty-two such copies.
                </p>
              )}
              <p className="leading-relaxed text-foreground/90">
                The rest of an LLM application has the same shape: retrieval chunks and their metadata, evaluation results, agent
                traces and chat logs, held as lists of JSON records by long-running processes. We have not measured those yet, and
                one part of them is the weak case today: when most of a record is a nested list of messages, packmem keeps that
                part as JSON text, so it saves less and loads slower than json.load.
              </p>
              <p className="text-sm text-muted-foreground">
                And where it is the wrong tool, see <a className="underline underline-offset-4" href="#limits">where it loses</a>.
              </p>
            </div>
          </Section>

          {/* ---------- compare ---------- */}
          <Section id="compare" title="packmem, polars, pandas and Arrow">
            <Lead>
              They solve different problems. The rows below are about holding records inside an application, which is what
              packmem is for, plus the analytics features where the dataframes are clearly ahead.
            </Lead>
            <div className="rounded-xl border bg-card/70 backdrop-blur-sm">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[11rem] whitespace-normal">
                      <span className="sr-only">Feature</span>
                    </TableHead>
                    {["packmem", "polars", "pandas", "Arrow"].map((t, i) => (
                      <TableHead key={t} className={cn("w-[6.6rem]", i === 0 && "bg-primary/10 text-foreground")}>
                        {t}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {COMPARE.map((r) => (
                    <TableRow key={r.feature} className="hover:bg-transparent">
                      <TableCell className="align-top text-sm leading-snug whitespace-normal">{r.feature}</TableCell>
                      {r.cells.map(([v, note], i) => (
                        <TableCell key={i} className={cn("align-top", i === 0 && "bg-primary/10")}>
                          <Cell v={v} note={note} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Checked against packmem 0.2.0 and the polars, pandas and pyarrow documentation, November 2026. Memory notes are the
              flights measurements above; Arrow&apos;s is pandas with its Arrow backend, the closest we measured.
            </p>
            <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
              {[
                ["packmem", "Your program keeps records as records, such as a server's dataset, a script's list or a training loader's annotations, and memory sets the limit. Change the container and keep the code."],
                ["polars", "Analytics: joins, windows and large group-bys over millions of rows, Parquet in and out, every core busy. Once the work is analysis rather than holding records, use a dataframe."],
                ["pandas", "The notebook ecosystem: plotting, statsmodels, scikit-learn and the large body of existing pandas code, on data that fits comfortably in memory."],
                ["Arrow", "The format between systems: handing columnar data to another process or language without copying, Parquet and Flight, and building query engines."],
              ].map(([h, t]) => (
                <div key={h} className="flex flex-col gap-1.5">
                  <h3 className="font-medium">Use {h} when</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{t}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* ---------- limits ---------- */}
          <Section id="limits" title="Where it loses">
            <ul className="flex flex-col gap-4 text-base leading-relaxed text-foreground/90">
              <li><b className="font-medium">Plain loops over every row are slower.</b> Each record is rebuilt on demand: {loopSlow} than the list in Python. Lazy rows fix loops that read a few fields; rewriting the loop as a query fixes it entirely.</li>
              <li><b className="font-medium">Random access to whole rows costs more:</b> {randomSlow} for 10,000 random rows.</li>
              <li><b className="font-medium">Dataframes still win analytics.</b> polars loads {Math.round(d.loads.packmem / d.loads.polars)} times faster than packmem, and pandas is faster on some float filters ({ms(d.loss.floatFilter.pandas)} against {ms(d.loss.floatFilter.packmem)}).</li>
              {d.ipGroup && (
                <li><b className="font-medium">Group-by over very many distinct values is slow.</b> 436 thousand distinct IP addresses over 2 million rows took {ms(d.ipGroup.packmem)}, against {ms(d.ipGroup.lo)} to {ms(d.ipGroup.hi)} in polars.</li>
              )}
              <li><b className="font-medium">Small tables gain nothing.</b> {d.breakEven}</li>
              {wk && (
                <li>
                  <b className="font-medium">Building a table from JavaScript objects is slow in WebAssembly.</b> In the Workers runtime,{" "}
                  {wk.rows.toLocaleString("en-US")} rows took {ms(wk.packmem.first_request_ms)} against {ms(wk.plain.first_request_ms)} for an
                  array, and the objects left behind count until the runtime collects them.
                </li>
              )}
              {hf && (
                <li>
                  <b className="font-medium">Hugging Face datasets is faster for batched access.</b> Slices and batched iteration over its
                  Arrow columns were about twice as fast as packmem&apos;s in our comparison on 665,298 LLaVA records,
                  and its compressed Parquet source is smaller at rest.
                </li>
              )}
              <li><b className="font-medium">A one-line swap can cost time.</b> sqlite-utils used {less(d.tools[0].a, d.tools[0].b)} memory but took {d.tools[0].tb.toFixed(2)} s against {d.tools[0].ta.toFixed(2)} s.</li>
              <li>
                <b className="font-medium">Sort, insert and delete rebuild the table,</b> in Python and in Node, so each costs time proportional to its size.
                {d.pgLoadNode.rows && d.pgLoadNode.copy &&
                  ` In Node, fromPg takes ${(d.pgLoadNode.rows.packmem_ms / d.pgLoadNode.rows.plain_ms).toFixed(1)} times as long as plain node-postgres rows; fromPgCopy, which streams COPY output into the native parser, took ${ms(d.pgLoadNode.copy.packmem_ms)} against ${ms(d.pgLoadNode.copy.plain_ms)}.`}
              </li>
            </ul>
          </Section>

          {/* ---------- use ---------- */}
          <Section id="use" title="Use it">
            <Tabs defaultValue="python">
              <TabsList>
                <TabsTrigger value="python">Python</TabsTrigger>
                <TabsTrigger value="node">Node</TabsTrigger>
                <TabsTrigger value="rust">Rust</TabsTrigger>
              </TabsList>
              <TabsContent value="python" className="flex flex-col gap-3">
                <Code install={SNIPPETS.python.install} lang={SNIPPETS.python.lang}>{SNIPPETS.python.code}</Code>
                <p className="text-sm text-muted-foreground">A list-of-dicts replacement for Python 3.10+: index, iterate, append, update, sort, query, and JSON straight from the columns.</p>
              </TabsContent>
              <TabsContent value="node" className="flex flex-col gap-3">
                <Code install={SNIPPETS.node.install} lang={SNIPPETS.node.lang}>{SNIPPETS.node.code}</Code>
                <p className="text-sm text-muted-foreground">An array-like table for Node 20+, Bun and Deno: list methods, lazy rows, CSV and Postgres COPY loaders, and JSON responses streamed from the columns. The same API runs on Cloudflare Workers through <code className="font-mono text-xs">packmem/wasm</code>. Prebuilt for Linux x86-64 and arm64 (glibc 2.17+ and musl), macOS on Apple silicon and Intel, and Windows x64; other platforms build from source with Rust.</p>
              </TabsContent>
              <TabsContent value="rust" className="flex flex-col gap-3">
                <Code install={SNIPPETS.rust.install} lang={SNIPPETS.rust.lang}>{SNIPPETS.rust.code}</Code>
                <p className="text-sm text-muted-foreground">The core: encodings, the sampling selector, the mutable table and the operators on packed data.</p>
              </TabsContent>
            </Tabs>
            <p className="text-sm leading-relaxed text-muted-foreground">
              <Badge variant="secondary" className="mr-2 align-[1px]">0.2.0 alpha</Badge>
              On <a className="underline underline-offset-4" href="https://pypi.org/project/packmem/">PyPI</a> and{" "}
              <a className="underline underline-offset-4" href="https://www.npmjs.com/package/packmem">npm</a>, with prebuilt builds for Linux (glibc
              and musl), macOS and Windows. <span className="whitespace-nowrap">Apache-2.0.</span>
            </p>
          </Section>

          {/* ---------- method ---------- */}
          <Section id="method" title="How these numbers were made">
            <ul className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
              <li>Python and server results on an Apple M4 Pro, {Math.round(Number(d.machineLine["hw.memsize"] ?? 51539607552) / 2 ** 30)} GB, macOS, Python {d.machineLine.python ?? "3.12"}, Node {d.demo.machine.node}. Medians of fresh processes. Load average {d.pyLoad ? `${d.pyLoad.lo.toFixed(1)} to ${d.pyLoad.hi.toFixed(1)}` : "unrecorded"} for the Python runs and {d.serverLoad ? `${d.serverLoad.lo.toFixed(0)} to ${d.serverLoad.hi.toFixed(0)}` : "unrecorded"} for the server runs, so treat differences under about 15% as noise.</li>
              <li>Server memory is measured after a forced garbage collection and 20 seconds idle; measured one second after loading, the Node servers read up to {Math.round(d.earlyExcess * 100)}% higher.</li>
              <li>Every packmem query and response was checked against the plain-container answer.</li>
              <li>
                Everything is reproducible from the repository: <code className="font-mono text-xs">benchmarks/run_all.py</code>, <code className="font-mono text-xs">demos/bench/bench.mjs</code>,{" "}
                <code className="font-mono text-xs">experiments/</code>. The full write-up is{" "}
                <a className="underline underline-offset-4" href={`${d.REPO}/blob/main/docs/report.md`}>docs/report.md</a>.
              </li>
            </ul>
          </Section>

          <Separator />
          <footer className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
            <p>{"// packmem · Apache-2.0 · "}<a className="underline underline-offset-4" href={d.REPO}>github.com/HamedMP/packmem</a></p>
            <p>{`// built from the results files on ${d.builtOn}`}</p>
            <p>{"// are you an agent? read "}<a className="underline underline-offset-4" href={`${d.REPO}/blob/main/docs/report.md`}>docs/report.md</a>{" instead"}</p>
          </footer>
        </div>
      </main>
    </>
  )
}
