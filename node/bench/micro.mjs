// In-process timings behind the numbers in node/README.md. Usage: [PACKMEM_PG_URL=...] node bench/micro.mjs
// Needs data/flights.jsonl (benchmarks/fetch_data.py). Writes bench/results/<platform>-<arch>.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import * as pm from "../index.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const FLIGHTS = here("../../data/flights.jsonl");
const REPS = 9;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(f) {
  await f();
  const xs = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    await f();
    xs.push(performance.now() - t0);
  }
  return +median(xs).toFixed(2);
}

const load0 = loadavg()[0];
const raw = readFileSync(FLIGHTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const t = pm.loadJsonl(FLIGHTS);
const rows = [];
const add = (name, plain, packed, note) => rows.push({ name, plain_ms: plain, packmem_ms: packed, note });

add(
  "All 336,776 rows as JSON bytes",
  await time(() => Buffer.from(JSON.stringify(raw)).length),
  await time(() => {
    let n = 0;
    for (const c of t.jsonChunks()) n += c.length;
    return n;
  }),
  "Buffer.from(JSON.stringify(array)) against jsonChunks()",
);
add(
  "Group by dest where carrier = UA",
  await time(() => {
    const o = {};
    for (const r of raw) if (r.carrier === "UA") o[r.dest] = (o[r.dest] ?? 0) + 1;
    return o;
  }),
  await time(() => t.groupCount("dest", { carrier: "UA" })),
);
add(
  "Sum distance where origin = JFK",
  await time(() => {
    let s = 0;
    for (const r of raw) if (r.origin === "JFK") s += r.distance;
    return s;
  }),
  await time(() => t.sum("distance", { origin: "JFK" })),
);

add(
  "Loop over every row, reading one field (full objects)",
  await time(() => {
    let s = 0;
    for (const r of raw) s += r.distance;
    return s;
  }),
  await time(() => {
    let s = 0;
    for (const r of t) s += r.distance;
    return s;
  }),
);
add(
  "Same loop with lazy rows",
  await time(() => {
    let s = 0;
    for (const r of raw) s += r.distance;
    return s;
  }),
  await time(() => {
    let s = 0;
    for (const r of t.lazy()) s += r.distance;
    return s;
  }),
);

const url = process.env.PACKMEM_PG_URL;
if (url) {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  add(
    "Load the flights table from Postgres",
    await time(async () => (await c.query("select * from flights")).rows.length),
    await time(async () => (await pm.fromPg(c, "select * from flights")).length),
    "node-postgres object rows against fromPg",
  );
  await c.end();
}

const result = { machine: { cpu: cpus()[0]?.model, node: process.version, platform: `${process.platform}-${process.arch}`, date: new Date().toISOString(), loadavg_before: +load0.toFixed(2), loadavg_after: +loadavg()[0].toFixed(2), reps: REPS }, rows };
mkdirSync(here("./results"), { recursive: true });
writeFileSync(here(`./results/${process.platform}-${process.arch}.json`), JSON.stringify(result, null, 2));
console.log(`${result.machine.cpu}, Node ${process.version}, load average ${result.machine.loadavg_before} before, ${result.machine.loadavg_after} after, median of ${REPS}\n`);
console.log("| In-process, flights data | Plain JS, ms | packmem, ms |\n| --- | --- | --- |");
for (const r of rows) console.log(`| ${r.name} | ${r.plain_ms} | ${r.packmem_ms} |`);
