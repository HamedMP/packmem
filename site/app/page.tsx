import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, GithubIcon } from "@hugeicons/core-free-icons"

import { Backdrop } from "@/components/site/backdrop"
import { Logo } from "@/components/site/logo"
import { ThemeToggle } from "@/components/site/theme-toggle"
import { Dumbbell, Figure, HBars, LogLines, NumbersTable, Stacked } from "@/components/site/charts"
import { less, mb, ms, speed } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import * as d from "@/lib/data"

const x = (v: number) => `${v >= 10 ? Math.round(v) : v.toFixed(1)}×`
const range = (xs: number[], digits = 1) => {
  const [lo, hi] = [Math.min(...xs).toFixed(digits), Math.max(...xs).toFixed(digits)]
  return lo === hi ? `about ${lo}` : `${lo} to ${hi}`
}

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

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-muted/60 p-4 font-mono text-[13px] leading-relaxed backdrop-blur-sm">
      <code>{children.trim()}</code>
    </pre>
  )
}

const SNIPPETS = {
  python: `pip install packmem

import packmem

rows = packmem.load_jsonl("events.jsonl")   # was: [json.loads(l) for l in f]
rows.count(status=404)
rows.group_count("country", path__prefix="/api/")
rows.where(carrier="UA").to_json()`,
  node: `npm install packmem

import { loadJsonl } from "packmem"

const rows = loadJsonl("events.jsonl")      // was: lines.map(JSON.parse)
rows.count({ status: 404 })
rows.groupCount("country")
return new Response(rows.where({ carrier: "UA" }).jsonWebStream())`,
  rust: `# Cargo.toml: packmem = { git = "https://github.com/HamedMP/packmem" }

let mut t = DynTable::new(Hint::Balanced);
let ua = Pred::Eq(Cell::Str("UA".into()));
let ids = t.select(carrier, &ua);
let miles = t.sum(distance, Some(&ids));`,
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
      <div className="pointer-events-none fixed inset-0 z-[1] bg-background/85 md:bg-transparent md:bg-linear-to-r md:from-background md:from-30% md:via-background/70 md:via-45% md:to-transparent md:to-62%" />

      <header className="fixed inset-x-0 top-0 z-20 flex items-center justify-between px-5 py-6 md:px-12 md:py-8">
        <a href="#top" aria-label="packmem, back to the top">
          <Logo />
        </a>
        <nav className="flex items-center gap-2">
          <Button variant="secondary" size="lg" className="hidden bg-secondary/70 backdrop-blur sm:inline-flex" render={<a href="#results" />}>
            Results
          </Button>
          <Button variant="secondary" size="lg" className="gap-2 bg-secondary/70 font-mono text-xs backdrop-blur" render={<a href={d.REPO} />}>
            <HugeiconsIcon icon={GithubIcon} strokeWidth={2} data-icon="inline-start" />
            v0.1.0
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
              <Button size="lg" render={<a href="#use" />}>
                Use it
              </Button>
              <Button size="lg" variant="outline" className="bg-background/40 backdrop-blur" render={<a href="#results" />}>
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
              Each field becomes one column with an encoding picked from a sample of its values. Every encoding keeps fast
              access to a single value, so nothing is unpacked in bulk, and filters run on the encoded form.
            </Lead>
            <div className="grid gap-6 sm:grid-cols-2">
              {[
                ["Dictionary", "carrier has 16 distinct values in 336,776 rows: store them once, and a 4-bit code per row. Counting UA compares codes."],
                ["Frame of reference", "distance is stored as the offset from the column minimum in the narrowest width that fits. Sums and range filters run on the narrow codes."],
                ["Run-length and blocks", "Long runs become one value and an end. Sorted timestamps get a minimum per block, so a time-range count is two binary searches."],
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
                  In Python the gap is wider on Linux: the flights take {mb(linuxPy.packmem)} against {mb(d.hero.b)} on the Mac. About
                  10 MB of what packmem holds on macOS is load buffers the macOS allocator keeps after loading; glibc returns them.
                  {linuxAccess &&
                    ` The costs are wider too: a plain loop over every row is ${speed(linuxAccess.loop.list, linuxAccess.loop.packmem).text} than the list, random rows ${speed(linuxAccess.random.list, linuxAccess.random.packmem).text}${linuxAccess.lazy ? `, and lazy rows ${Math.abs(linuxAccess.lazy / linuxAccess.loop.list - 1) < 0.1 ? "only match" : speed(linuxAccess.loop.list, linuxAccess.lazy).text.replace("about the same", "match")} the list (${ms(linuxAccess.lazy)} against ${ms(linuxAccess.loop.list)})` : ""}.`}
                </p>
              )}
              <p className="text-base leading-relaxed text-foreground/90">
                Node keeps plain objects leaner on Linux, so its saving is smaller there. The Postgres rows on Linux need a caveat:
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
              <li><b className="font-medium">A one-line swap can cost time.</b> sqlite-utils used {less(d.tools[0].a, d.tools[0].b)} memory but took {d.tools[0].tb.toFixed(2)} s against {d.tools[0].ta.toFixed(2)} s.</li>
              <li><b className="font-medium">Loading from Postgres is slower in Node,</b> and sort, insert and delete exist only in the Python package, where each rebuilds the table.</li>
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
                <Code>{SNIPPETS.python}</Code>
                <p className="text-sm text-muted-foreground">A list-of-dicts replacement for Python 3.10+: index, iterate, append, update, sort, query, and JSON straight from the columns.</p>
              </TabsContent>
              <TabsContent value="node" className="flex flex-col gap-3">
                <Code>{SNIPPETS.node}</Code>
                <p className="text-sm text-muted-foreground">An array-like table for Node 20+, with Postgres loaders and JSON responses streamed from the columns. Prebuilt for Linux x86-64 and arm64 (glibc 2.34+), macOS on Apple silicon and Windows x64; other platforms build from source with Rust.</p>
              </TabsContent>
              <TabsContent value="rust" className="flex flex-col gap-3">
                <Code>{SNIPPETS.rust}</Code>
                <p className="text-sm text-muted-foreground">The core: encodings, the sampling selector, the mutable table and the operators on packed data.</p>
              </TabsContent>
            </Tabs>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">0.1.0 alpha</Badge>
              On <a className="underline underline-offset-4" href="https://pypi.org/project/packmem/">PyPI</a> and{" "}
              <a className="underline underline-offset-4" href="https://www.npmjs.com/package/packmem">npm</a>, with prebuilt builds for Linux, macOS on Apple
              silicon and Windows. Apache-2.0.
            </div>
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
