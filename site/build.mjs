// Builds the project page from the recorded benchmark results. Every number on the page is read from a results
// file at build time; nothing is typed in by hand except prose. Output: site/dist/index.html (self-contained).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const REPO = "https://github.com/HamedMP/packmem";

const jsonl = (p) => readFileSync(root(p), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const med = (v) => (Array.isArray(v) ? v[0] : v); // results store [median, min, max]

// ---------- data ----------

const heap = jsonl("experiments/results/heap_results.jsonl");
const heapPm = jsonl("experiments/results/packmem_rss.jsonl").find((r) => r.label === "packmem-balanced");
const RUNTIMES = [
  ["java-logs", "Java 21, a HashMap per record"],
  ["python-logs", "Python, a dict per record"],
  ["ruby-logs", "Ruby, a Hash per record"],
  ["node-logs", "Node, an object per record"],
  ["redis-logs", "Redis, a hash per record"],
];
const runtimeMem = RUNTIMES.map(([k, label]) => ({ label, value: heap.find((h) => h.label === k).resident_anon_mb }));
runtimeMem.push({ label: "packmem", value: heapPm.resident_anon_mb, hi: true });
const composition = RUNTIMES.map(([k, label]) => {
  const w = heap.find((h) => h.label === k).words_pct;
  return { label: label.split(",")[0], parts: [w.zero + w.pointer + w.int8 + w.int16 + w.int32, w.text, w.other] };
});

const ds = jsonl("benchmarks/results/mac-m4pro/datasets.jsonl");
const machineLine = ds.find((d) => d.machine)?.machine ?? {};
const flights = (v) => ds.find((d) => d.variant === v && d.dataset === "flights");
const holders = [
  ["list", "List of dicts"],
  ["pandas", "pandas"],
  ["pandas_arrow", "pandas, Arrow-backed"],
  ["polars", "polars"],
  ["packmem", "packmem"],
].map(([k, label]) => ({ label, value: med(flights(k).rss_mb), peak: med(flights(k).peak_mb), load: med(flights(k).load_s), hi: k === "packmem", base: k === "list" }));
const L = flights("list"), P = flights("packmem");
const QUERIES = [
  ["group count by dest", "Group by destination"],
  ["sum air_time", "Sum a column"],
  ["count dep_delay>60", "Count delays over 60 min"],
  ["count carrier=UA", "Count one carrier"],
  ["sum distance where origin=JFK", "Sum with a filter"],
  ["10k random rows as dicts", "10,000 random rows as dicts"],
  ["loop over every row", "Python loop over every row"],
];
const queries = QUERIES.map(([k, label]) => ({ label, a: L.q[k].ms[0], b: P.q[k].ms[0] }));
queries.push({ label: "Same loop, lazy rows", a: L.q["loop over every row"].ms[0], b: P.q["loop over every row, lazy rows"].ms[0] });

const cross = jsonl("benchmarks/results/mac-m4pro/crossover_flights.jsonl").map((r) => ({ x: r.rows, a: r.list.mb, b: r.packmem.mb }));

const apps = jsonl("benchmarks/results/mac-m4pro/apps.jsonl");
const appMed = (prefix, kind, field) => {
  const xs = apps.filter((a) => a.run.startsWith(prefix) && a.run.endsWith(`(${kind})`)).map((a) => a[field]).sort((x, y) => x - y);
  return xs[Math.floor(xs.length / 2)];
};
const TOOLS = [
  ["sqlite-utils insert", "sqlite-utils: insert a 104 MB JSON array"],
  ["jello flights", "jello: query 104 MB of JSON lines"],
  ["jello nginx", "jello: query 12 MB of nginx logs"],
];
const tools = TOOLS.map(([p, label]) => ({
  label,
  a: appMed(p, "original", "peak_mb"),
  b: appMed(p, "patched", "peak_mb"),
  ta: appMed(p, "original", "seconds"),
  tb: appMed(p, "patched", "seconds"),
}));

const demo = JSON.parse(readFileSync(root("demos/bench/results/darwin-arm64.json"), "utf8"));
const FW = [["express", "Express"], ["nextjs", "Next.js"], ["fastapi", "FastAPI"]];
const dr = (f, m) => demo.results.find((r) => r.framework === f && r.mode === m);
const servers = FW.map(([f, label]) => ({ label, a: dr(f, "baseline").idle_rss_mb, b: dr(f, "packmem").idle_rss_mb, pa: dr(f, "baseline").peak_rss_mb, pb: dr(f, "packmem").peak_rss_mb }));
const endpointNames = dr("express", "baseline").endpoints.map((e) => e.name);

const hero = { a: med(L.rss_mb), b: med(P.rss_mb) };

// ---------- formatting ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("en-US");
const mb = (v) => (v < 10 ? v.toFixed(1) : nf.format(Math.round(v))) + " MB";
const ms = (v) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : nf.format(Math.round(v))) + " ms";
const times = (a, b) => {
  const r = a / b;
  return r >= 1 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}× ${"less"}` : `${(1 / r).toFixed(1)}× more`;
};
const speed = (a, b) => {
  const r = a / b;
  if (r > 1.1) return { text: `${r >= 10 ? nf.format(Math.round(r)) : r.toFixed(1)}× faster`, good: true };
  if (r < 0.9) return { text: `${(1 / r).toFixed(1)}× slower`, good: false };
  return { text: "about the same", good: null };
};
const tip = (obj) => esc(JSON.stringify(obj));

// ---------- chart builders (HTML + CSS positioning; text never scales with the chart) ----------

function table(head, rows) {
  return `<details class="tv"><summary>Show the numbers</summary><div class="tw"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div></details>`;
}

function legend(items) {
  return `<ul class="legend">${items.map(([cls, label, shape = "round"]) => `<li><span class="key ${shape} ${cls}"></span>${esc(label)}</li>`).join("")}</ul>`;
}

/** One series of horizontal bars; the highlighted row carries the accent, the rest stay neutral. */
function hbars(rows, { unit = mb } = {}) {
  const max = Math.max(...rows.map((r) => r.value));
  return `<div class="hbars">${rows
    .map(
      (r) => `<div class="hrow${r.hi ? " hi" : ""}" tabindex="0" data-tip="${tip({ title: r.label, rows: [["", unit(r.value)]] })}">
  <span class="lab">${esc(r.label)}</span>
  <span class="track"><span class="bar" style="width:${Math.max(0.4, (r.value / max) * 82).toFixed(2)}%"></span><span class="val">${unit(r.value)}</span></span>
</div>`,
    )
    .join("")}</div>`;
}

/** 100% stacked bars, three parts. */
function stacked(rows, names) {
  return `${legend(names.map((n, i) => [`s${i + 1}`, n, "sq"]))}<div class="stacks">${rows
    .map((r) => {
      const tot = r.parts.reduce((a, b) => a + b, 0);
      return `<div class="srow"><span class="lab">${esc(r.label)}</span><span class="stack">${r.parts
        .map((p, i) => {
          const pct = (p / tot) * 100;
          const label = pct >= 14 ? `<span class="in">${Math.round(pct)}%</span>` : "";
          return `<span class="seg s${i + 1}" tabindex="0" style="width:${pct.toFixed(2)}%" data-tip="${tip({ title: r.label, rows: [[names[i], `${Math.round(pct)}% of words`]] })}">${label}</span>`;
        })
        .join("")}</span></div>`;
    })
    .join("")}</div>`;
}

function logPos(v, lo, hi) {
  return ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100;
}
function linPos(v, lo, hi) {
  return ((v - lo) / (hi - lo)) * 100;
}

/** Before/after dots per row, connected. `a` is the baseline (series 2), `b` is packmem (series 1). */
function dumbbell(rows, { log = false, unit, aName, bName, ticks, lo, hi, verdict }) {
  const pos = (v) => (log ? logPos(v, lo, hi) : linPos(v, lo, hi));
  const tickText = (t, i) => (i === ticks.length - 1 ? unit(t) : unit(t).replace(/ (MB|ms)$/, "")).replace(/\.0( |$)/, "$1");
  const axis = `<div class="axis">${ticks.map((t, i) => `<span style="left:${pos(t).toFixed(2)}%">${esc(tickText(t, i))}</span>`).join("")}</div>`;
  const grid = ticks.map((t) => `<span class="gl" style="left:${pos(t).toFixed(2)}%"></span>`).join("");
  return `${legend([["s2", aName], ["s1", bName]])}<div class="dumb">${rows
    .map((r) => {
      const pa = pos(r.a), pb = pos(r.b);
      const v = verdict(r);
      return `<div class="drow" tabindex="0" data-tip="${tip({ title: r.label, rows: [[aName, unit(r.a)], [bName, unit(r.b)], ["", v.text]] })}">
  <span class="lab">${esc(r.label)}</span>
  <span class="plot">${grid}<span class="conn" style="left:${Math.min(pa, pb).toFixed(2)}%;width:${Math.abs(pa - pb).toFixed(2)}%"></span><span class="dot s2" style="left:${pa.toFixed(2)}%"></span><span class="dot s1" style="left:${pb.toFixed(2)}%"></span></span>
  <span class="verdict${v.good === false ? " bad" : ""}">${esc(v.text)}</span>
</div>`;
    })
    .join("")}<div class="drow axisrow"><span class="lab"></span><span class="plot">${axis}</span><span class="verdict"></span></div></div>`;
}

/** Two lines on log-log axes with a crosshair readout. */
function lines(points, { aName, bName, xTicks, yTicks, xLo, xHi, yLo, yHi, id }) {
  const X = (x) => logPos(x, xLo, xHi), Y = (y) => 100 - logPos(y, yLo, yHi);
  const path = (k) => points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(3)},${Y(p[k]).toFixed(3)}`).join(" ");
  const data = points.map((p) => ({ x: X(p.x), rows: p.x, a: p.a, b: p.b }));
  const last = points[points.length - 1];
  return `${legend([["s2", aName, "line"], ["s1", bName, "line"]])}
<div class="lchart" id="${id}" data-points="${esc(JSON.stringify(data))}" data-names="${esc(JSON.stringify([aName, bName]))}" tabindex="0" aria-label="${esc(`${aName} and ${bName} memory by number of rows`)}">
  <div class="yaxis">${yTicks.map((t) => `<span style="top:${Y(t).toFixed(2)}%">${esc(mb(t).replace(/\.0 /, " "))}</span>`).join("")}</div>
  <div class="area">
    ${yTicks.map((t) => `<span class="hl" style="top:${Y(t).toFixed(2)}%"></span>`).join("")}
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="ln s2" d="${path("a")}"/><path class="ln s1" d="${path("b")}"/></svg>
    <span class="end s2" style="left:${X(last.x)}%;top:${Y(last.a)}%"></span><span class="end s1" style="left:${X(last.x)}%;top:${Y(last.b)}%"></span>
    <span class="elab" style="top:${Y(last.a)}%">${esc(mb(last.a))}</span><span class="elab" style="top:${Y(last.b)}%">${esc(mb(last.b))}</span>
    <span class="xhair" hidden></span>
  </div>
  <div class="xaxis">${xTicks.map((t) => `<span style="left:${X(t).toFixed(2)}%">${t >= 1e6 ? t / 1e6 + "M" : t >= 1e3 ? t / 1e3 + "K" : t}</span>`).join("")}</div>
</div>`;
}

const figure = (title, sub, body, tbl, note = "") =>
  `<figure class="card"><figcaption><h3>${esc(title)}</h3>${sub ? `<p>${sub}</p>` : ""}</figcaption>${body}${note ? `<p class="note">${note}</p>` : ""}${tbl}</figure>`;

// ---------- sections ----------

const memVerdict = (r) => ({ text: times(r.a, r.b), good: r.b < r.a });
const timeVerdict = (r) => speed(r.a, r.b);

const chartRuntimes = figure(
  "The same 75.5 MB of web logs, held by six runtimes",
  "Resident memory after loading 300,000 records, one process each.",
  hbars(runtimeMem),
  table(["Holder", "Resident MB"], runtimeMem.map((r) => [r.label, r.value.toFixed(1)])),
  "Linux, 2-core x86 sandbox, synthetic web log. packmem here is the Rust library with the balanced setting.",
);

const chartComposition = figure(
  "What those bytes are",
  "Each 8-byte word of a 64 MB sample of the heap, classified.",
  stacked(composition, ["Bookkeeping: zeros, pointers, small integers", "Text", "Other"]),
  table(["Runtime", "Bookkeeping %", "Text %", "Other %"], composition.map((r) => [r.label, ...r.parts.map((p) => p.toFixed(1))])),
  "Java stores pointers as 32-bit values, so its pointer share is understated; Node's text share includes strings awaiting garbage collection.",
);

const chartHolders = figure(
  "336,776 real flights in Python",
  "Resident memory after loading nycflights13 (104 MB of JSON lines). Median of 5 fresh processes.",
  hbars(holders),
  table(["Holder", "Resident MB", "Peak MB", "Load s"], holders.map((r) => [r.label, r.value.toFixed(1), r.peak.toFixed(1), r.load.toFixed(2)])),
);

const qmax = Math.max(...queries.flatMap((q) => [q.a, q.b]));
const chartQueries = figure(
  "Queries on the same data: list of dicts against packmem",
  "Milliseconds, log scale; each dot is a median of 5 processes. Further left is faster.",
  dumbbell(queries, { log: true, unit: ms, aName: "List of dicts", bName: "packmem", lo: 0.1, hi: 1000, ticks: [0.1, 1, 10, 100, 1000].filter((t) => t <= Math.max(1000, qmax)), verdict: timeVerdict }),
  table(["Query", "List of dicts ms", "packmem ms", "Change"], queries.map((q) => [q.label, q.a.toFixed(2), q.b.toFixed(2), speed(q.a, q.b).text])),
  "The two slower rows are the honest cost: plain loops rebuild a dict per record. Lazy rows decode only the fields a loop reads.",
);

const chartCross = figure(
  "When it starts to pay off",
  "Resident memory against number of rows loaded from the flight data, both axes log scale.",
  lines(cross, { id: "cross", aName: "List of dicts", bName: "packmem", xLo: 100, xHi: 1_000_000, yLo: 0.1, yHi: 3000, xTicks: [100, 1000, 10000, 100000, 1000000], yTicks: [0.1, 1, 10, 100, 1000] }),
  table(["Rows", "List MB", "packmem MB"], cross.map((c) => [nf.format(c.x), c.a.toFixed(2), c.b.toFixed(2)])),
  "Break-even is near 300 rows. Below about 10,000 rows most of what packmem holds is load buffers, not data.",
);

const chartTools = figure(
  "Open-source tools, one line changed",
  "Peak memory of the whole process, original against patched. Outputs were identical (database contents hashed).",
  dumbbell(tools, { unit: mb, aName: "Original", bName: "One line changed", lo: 0, hi: 2000, ticks: [0, 1000, 2000], verdict: memVerdict }),
  table(["Tool and task", "Peak MB before", "Peak MB after", "Seconds before", "Seconds after"], tools.map((t) => [t.label, t.a.toFixed(0), t.b.toFixed(0), t.ta.toFixed(2), t.tb.toFixed(2)])),
);

const chartServers = figure(
  "A web server holding the dataset",
  "Idle resident memory of the whole server process after loading the 336,776 flights.",
  dumbbell(servers, { unit: mb, aName: "Array of objects / list of dicts", bName: "packmem", lo: 0, hi: 800, ticks: [0, 200, 400, 600, 800], verdict: memVerdict }),
  table(["Framework", "Idle MB before", "Idle MB after", "Peak MB before", "Peak MB after"], servers.map((s) => [s.label, s.a, s.b, s.pa, s.pb])),
);

function latencyTable() {
  const head = `<tr><th>Endpoint</th>${FW.map(([, l]) => `<th colspan="2">${esc(l)}</th>`).join("")}</tr><tr><th></th>${FW.map(() => "<th>before → after</th><th></th>").join("")}</tr>`;
  const body = endpointNames
    .map((name, i) => {
      const cells = FW.map(([f]) => {
        const a = dr(f, "baseline").endpoints[i], b = dr(f, "packmem").endpoints[i];
        const s = speed(a.median_ms, b.median_ms);
        return `<td class="n">${esc(ms(a.median_ms))} → ${esc(ms(b.median_ms))}</td><td class="n ${s.good === false ? "bad" : s.good ? "good" : ""}">${esc(s.text)}</td>`;
      }).join("");
      return `<tr><td>${esc(name)}</td>${cells}</tr>`;
    })
    .join("");
  return `<div class="card"><h3>Response times, same routes in all three</h3><p class="sub">Client on the same machine; medians of 30 requests (5 or 3 for exports; wall time for the concurrent row). Every packmem response was identical to the baseline response.</p><div class="tw"><table class="lat"><thead>${head}</thead><tbody>${body}</tbody></table></div></div>`;
}

const code = (s) => `<pre><code>${esc(s.trim())}</code></pre>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>packmem</title>
<meta name="description" content="Keep records as packed columns your code can still index, loop over, update and query, without decompressing anything. Python, Node and Rust.">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2a78d6"/><rect x="7" y="8" width="4" height="16" rx="1" fill="#fff"/><rect x="14" y="12" width="4" height="12" rx="1" fill="#fff"/><rect x="21" y="16" width="4" height="8" rx="1" fill="#fff"/></svg>')}">
<style>${readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8")}</style>
</head>
<body>
<header class="top"><a class="brand" href="#">packmem</a><nav><a href="#why">Why</a><a href="#how">How</a><a href="#results">Results</a><a href="#servers">Servers</a><a href="#limits">Limits</a><a href="#libraries">Libraries</a><a href="${REPO}">GitHub</a></nav></header>
<main>

<section class="hero">
  <p class="eyebrow">Open-source research project · Rust core, Python and Node packages</p>
  <h1>Your data is 104 MB.<br>Your program holds ${nf.format(Math.round(hero.a))} MB.</h1>
  <p class="lede">Load 336,776 flight records into Python and the list of dicts takes ${mb(hero.a)}. packmem holds the same records in <strong>${mb(hero.b)}</strong>, and your code still indexes them, loops over them, appends to them and filters them, without decompressing anything.</p>
  <div class="herofig"><span class="big">${Math.round(hero.a / hero.b)}×</span><span>less memory than a list of dicts, from changing one line. Against polars it is ${(med(flights("polars").rss_mb) / hero.b).toFixed(0)}× less.</span></div>
  ${code(`rows = [json.loads(line) for line in open("flights.jsonl")]   # ${mb(hero.a)}
rows = packmem.load_jsonl("flights.jsonl")                    # ${mb(hero.b)}`)}
  <div class="tiles">
    <div><span>Express server holding the data</span><strong>${servers[0].a} → ${servers[0].b} MB</strong></div>
    <div><span>FastAPI server holding the data</span><strong>${servers[2].a} → ${servers[2].b} MB</strong></div>
    <div><span>jello, one line changed</span><strong>${nf.format(Math.round(tools[1].a))} → ${nf.format(Math.round(tools[1].b))} MB</strong></div>
  </div>
</section>

<section id="why">
  <p class="kicker">Chapter 1</p>
  <h2>Most of a program's memory is not your data</h2>
  <p>Parse a file into objects and every value gets wrapped: an object header, a pointer to it, a hash slot for its key, padding to the next boundary. We loaded the same web log into five runtimes and looked at what the memory actually held. The file grew 2.7 to 9 times, and in every runtime except Node most of the words were zeros, pointers and small counters.</p>
  <div class="grid2">${chartRuntimes}${chartComposition}</div>
  <p>Operating systems already compress memory pages (zram, zswap, the macOS compressor). That recovers 2 to 8 times, but a compressed page has to be decompressed before any byte in it is read. The larger saving is not to create the overhead in the first place.</p>
</section>

<section id="how">
  <p class="kicker">Chapter 2</p>
  <h2>Pack the columns, and query them packed</h2>
  <p>packmem stores each field of a record collection as one column and picks an encoding for it from a sample of the values. Every encoding keeps fast access to a single value, so nothing is ever unpacked in bulk, and filters run on the encoded form.</p>
  <div class="enc">
    <div><h4>Dictionary</h4><p><code>carrier</code> has 16 distinct values in 336,776 rows: store them once, and a 4-bit code per row. "Count UA" compares codes.</p></div>
    <div><h4>Frame of reference</h4><p>Store <code>distance</code> as the offset from the column minimum in the narrowest width that fits. Sums and range filters run on the narrow codes.</p></div>
    <div><h4>Run-length and blocks</h4><p>Long runs become one (value, end) pair. Sorted timestamps get a minimum per block of 1,024, so a time-range count is two binary searches.</p></div>
    <div><h4>FSST strings</h4><p>Frequent substrings become 1-byte codes and each string still decodes on its own, so a single row is cheap to read.</p></div>
  </div>
  <p>Writes land in a small uncompressed tail that is packed as the table grows; updates to packed rows go to a patch map. Output goes straight from the columns too: a JSON response is written from the packed data without building an object per row.</p>
</section>

<section id="results">
  <p class="kicker">Chapter 3</p>
  <h2>On real data, in Python</h2>
  <p>The flight data is the public nycflights13 set: 19 columns of integers, floats, short strings and timestamps, with missing values. packmem used less memory than every dataframe library we tried, while still behaving like a list.</p>
  ${chartHolders}
  ${chartQueries}
  <div class="grid2">${chartCross}${chartTools}</div>
</section>

<section id="servers">
  <p class="kicker">Chapter 4</p>
  <h2>Inside a web server</h2>
  <p>A common shape for internal tools and APIs: load a dataset at start-up, then serve filtered pages, aggregates and exports from memory. We built the same five routes in Express, Next.js and FastAPI and switched how the data is held with one environment variable.</p>
  ${chartServers}
  ${latencyTable()}
  <p>Python gets both: a tenth of the memory and queries tens of times faster than loops over dicts. In Node the gain is memory; V8 already scans objects of one shape quickly, so speed is level, ahead on filters and group-by and level on exports. Exports never build a full-size string, which is why concurrent exports keep their lead.</p>
</section>

<section id="limits">
  <p class="kicker">Chapter 5</p>
  <h2>Where it loses</h2>
  <ul class="limits">
    <li><strong>Plain loops over every row are slower.</strong> Each record is rebuilt as a dict or object on demand: ${speed(L.q["loop over every row"].ms[0], P.q["loop over every row"].ms[0]).text} than the list in Python. Lazy rows fix this for loops that read a few fields; rewriting the loop as a query fixes it entirely.</li>
    <li><strong>Random access to whole rows costs more</strong>: ${speed(L.q["10k random rows as dicts"].ms[0], P.q["10k random rows as dicts"].ms[0]).text} for 10,000 random rows.</li>
    <li><strong>Dataframes still win analytics.</strong> polars loads ${Math.round(med(P.load_s) / med(flights("polars").load_s))} times faster than packmem, and pandas is faster on some float filters (${ms(flights("pandas").q["count dep_delay>60"].ms[0])} against ${ms(P.q["count dep_delay>60"].ms[0])} for delays over 60 minutes). packmem is for code that wants a list, not a dataframe.</li>
    <li><strong>Small tables gain nothing.</strong> Below about 300 rows packmem uses more memory than the list.</li>
    <li><strong>Sort, insert and delete rebuild the table.</strong> They exist and are tested, but cost time proportional to the table.</li>
    <li><strong>Unchanged programs gain nothing.</strong> You have to swap the container. For code you cannot change, page compression is still the tool, and the two combine.</li>
  </ul>
</section>

<section id="libraries">
  <p class="kicker">Use it</p>
  <h2>Three libraries, one core</h2>
  <div class="libs">
    <div class="lib"><div><h4>Python <span class="tag">alpha</span></h4><p>A list-of-dicts replacement: index, iterate, append, update, sort, plus <code>where</code>, <code>sum</code>, <code>group_count</code> and JSON output from the columns. Python 3.10+.</p></div>
      ${code(`import packmem

rows = packmem.load_jsonl("events.jsonl")
rows.count(status=404)
rows.group_count("country")
rows.where(path__prefix="/api/").to_json()`)}</div>
    <div class="lib"><div><h4>Node <span class="tag">alpha</span></h4><p>An array-like table for Node 18+. Filters return row ids; JSON responses stream straight from the columns into Express, Fastify or a fetch <code>Response</code>.</p></div>
      ${code(`import { loadJsonl } from "packmem";

const rows = loadJsonl("events.jsonl");
rows.count({ status: 404 });
rows.groupCount("country");
// in a route handler
const hits = rows.where({ status: 404 });
return new Response(hits.jsonWebStream());`)}</div>
    <div class="lib"><div><h4>Rust <span class="tag">core</span></h4><p>The encodings, the sampling selector, the mutable table and the operators that run on packed data. Both packages are thin bindings over it.</p></div>
      ${code(`let ua = Pred::Eq(Cell::Str("UA".into()));
let ids = t.select(carrier, &ua);
let km = t.sum(distance, Some(&ids));`)}</div>
  </div>
  <p class="status">Not yet on PyPI or npm: build from source with <code>maturin</code> (Python) or <code>npm run build</code> (Node). Tested on macOS (Apple silicon) and Linux x86-64; Windows and WebAssembly builds are not done.</p>
</section>

<section id="method">
  <p class="kicker">Method</p>
  <h2>How these numbers were made</h2>
  <ul class="method">
    <li>Python and server results: ${esc(machineLine["machdep.cpu.brand_string"] ?? "Apple M4 Pro")}, ${Math.round(Number(machineLine["hw.memsize"] ?? 51539607552) / 2 ** 30)} GB, macOS, Python ${esc(machineLine.python ?? "3.12")}, ${esc(demo.machine.node)}. Medians of fresh processes. The machine was in normal use (load average 3 to 8), so treat differences under about 15% as noise.</li>
    <li>Memory on macOS is the physical footprint or resident size of the whole process tree; on Linux, resident anonymous memory read from <code>/proc</code>.</li>
    <li>The runtime comparison in chapter 1 is older: a 2-core Linux sandbox and a synthetic log. It is not on the same axis as the Mac numbers.</li>
    <li>Every packmem query and response was checked against the plain-container answer.</li>
    <li>Everything is reproducible from the repository: <code>benchmarks/run_all.py</code>, <code>demos/bench/bench.mjs</code>, <code>experiments/</code>. The full write-up is <a href="${REPO}/blob/main/docs/report.md">docs/report.md</a>.</li>
  </ul>
</section>

</main>
<footer><p>packmem · Apache-2.0 · <a href="${REPO}">${REPO.replace("https://", "")}</a></p><p class="muted">Built from the results files on ${new Date().toISOString().slice(0, 10)}.</p></footer>
<div id="tt" role="tooltip" hidden></div>
<script>${readFileSync(fileURLToPath(new URL("./tooltip.js", import.meta.url)), "utf8")}</script>
</body>
</html>`;

mkdirSync(root("site/dist"), { recursive: true });
writeFileSync(root("site/dist/index.html"), html);
console.log(`site/dist/index.html ${(html.length / 1024).toFixed(0)} KB`);
