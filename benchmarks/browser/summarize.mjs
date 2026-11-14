// Markdown tables (medians) from results/runs.jsonl. usage: node summarize.mjs results/runs.jsonl > results/tables.md
import { readFileSync } from "node:fs";

const runs = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const groups = new Map();
for (const r of runs) {
  const k = [r.dataset, r.rows, r.encoding, r.network, r.format].join("|");
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const med = (ds, n, enc, net, fmt, field) => median((groups.get([ds, n, enc, net, fmt].join("|")) ?? []).map((r) => r[field]));
const datasets = [...new Set(runs.map((r) => r.dataset))];
const sizesOf = (ds) => [...new Set(runs.filter((r) => r.dataset === ds).map((r) => r.rows))].sort((a, b) => a - b);
const n0 = (x) => (x == null ? "–" : Math.round(x).toLocaleString("en-US"));
const ms = (x) => (x == null ? "–" : x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : Math.round(x).toLocaleString("en-US"));
const mb = (x) => (x == null ? "–" : (x / 1e6).toFixed(x < 1e5 ? 3 : 1));
const ratio = (j, p) => (j == null || p == null || p === 0 ? "–" : `${(j / p).toFixed(2)}x`);
const pct = (p, j) => (j == null || p == null ? "–" : `${((p - j) / j) * 100 >= 0 ? "+" : ""}${Math.round(((p - j) / j) * 100)}%`);

const meta = runs[0];
console.log(`Medians of ${Math.max(...[...groups.values()].map((g) => g.length))} runs per cell. packmem ${meta.packmem}, Chromium ${meta.chrome}.\n`);

// counts must agree, or a timing compares different work
for (const ds of datasets)
  for (const n of sizesOf(ds)) {
    const counts = new Set(runs.filter((r) => r.dataset === ds && r.rows === n).map((r) => r.count));
    if (counts.size !== 1) console.log(`**Warning:** ${ds} ${n}: filter counts differ between runs: ${[...counts].join(", ")}\n`);
  }

const has = (enc, net) => runs.some((r) => r.encoding === enc && r.network === net);
if (has("identity", "local")) {
console.log("## Payload size (bytes sent)\n");
console.log("| dataset | rows | JSON | packmem | packmem vs JSON | JSON, Brotli 5 | packmem, Brotli 5 | packmem vs JSON |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const ds of datasets)
  for (const n of sizesOf(ds)) {
    const jb = med(ds, n, "identity", "local", "json", "payload_bytes"), pb = med(ds, n, "identity", "local", "packmem", "payload_bytes");
    const jz = med(ds, n, "br", "local", "json", "payload_bytes"), pz = med(ds, n, "br", "local", "packmem", "payload_bytes");
    console.log(`| ${ds} | ${n0(n)} | ${n0(jb)} | ${n0(pb)} | ${pct(pb, jb)} | ${n0(jz)} | ${n0(pz)} | ${pct(pz, jz)} |`);
  }

}

if (has("gzip", "local")) {
  console.log("## main 90602dc packmem/http gzip: payload size (bytes sent)\n");
  console.log("packmem bytes gzipped inside the payload (`application/vnd.packmem; enc=gzip`, not below 1,024 bytes) against JSON with `content-encoding: gzip`, both at zlib's default level. packmem 0.3.0 bytes; the format is unchanged on main, the HTTP layer is newer.\n");
  console.log("| dataset | rows | JSON, gzip | packmem, gzip in payload | packmem vs JSON |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const ds of datasets)
    for (const n of sizesOf(ds)) {
      const j = med(ds, n, "gzip", "local", "json", "payload_bytes"), p = med(ds, n, "gzip", "local", "packmem", "payload_bytes");
      if (j != null) console.log(`| ${ds} | ${n0(n)} | ${n0(j)} | ${n0(p)} | ${pct(p, j)} |`);
    }
  console.log("");
}

for (const [enc, net, title] of [
  ["identity", "local", "uncompressed, loopback"],
  ["br", "local", "Brotli 5, loopback"],
  ["br", "20mbit", "Brotli 5, 20 Mbit/s and 20 ms latency"],
  ["gzip", "local", "main 90602dc packmem/http gzip, loopback; packmem unzipped in the page with DecompressionStream"],
  ["gzip", "20mbit", "main 90602dc packmem/http gzip, 20 Mbit/s and 20 ms latency; unzipped in the page"],
].filter(([e, n]) => has(e, n))) {
  console.log(`\n## Time until usable, ms (${title})\n`);
  console.log("JSON: fetch + JSON.parse. packmem: fetch + Table.fromBytes (WebAssembly start-up excluded, listed separately).\n");
  console.log("| dataset | rows | JSON body | JSON parse | JSON total | packmem body | packmem open | packmem total | JSON ÷ packmem |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const ds of datasets)
    for (const n of sizesOf(ds)) {
      const j = (f) => med(ds, n, enc, net, "json", f), p = (f) => med(ds, n, enc, net, "packmem", f);
      console.log(`| ${ds} | ${n0(n)} | ${ms(j("body_ms"))} | ${ms(j("open_ms"))} | ${ms(j("ready_ms"))} | ${ms(p("body_ms"))} | ${ms(p("open_ms"))} | ${ms(p("ready_ms"))} | ${ratio(j("ready_ms"), p("ready_ms"))} |`);
    }
}

if (has("identity", "local")) {
console.log("\n## After it is usable, ms (uncompressed, loopback)\n");
console.log("First 50 rows as objects (JSON: Array.slice; packmem: built from the columns); one filter and count; packmem building every row as an object.\n");
console.log("| dataset | rows | first 50, JSON | first 50, packmem | filter, JSON | filter, packmem | all rows as objects, packmem | JSON.parse |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const ds of datasets)
  for (const n of sizesOf(ds)) {
    const j = (f) => med(ds, n, "identity", "local", "json", f), p = (f) => med(ds, n, "identity", "local", "packmem", f);
    console.log(`| ${ds} | ${n0(n)} | ${ms(j("first50_ms"))} | ${ms(p("first50_ms"))} | ${ms(j("filter_ms"))} | ${ms(p("filter_ms"))} | ${ms(p("materialize_all_ms"))} | ${ms(j("open_ms"))} |`);
  }

console.log("\n## Page memory held by the data, MB (uncompressed, loopback)\n");
console.log("Whole-page memory after GC with the data held, minus the same before the fetch (after WebAssembly start-up for packmem).\n");
console.log("| dataset | rows | JSON objects | packmem table | JSON ÷ packmem | WebAssembly start-up, ms |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const ds of datasets)
  for (const n of sizesOf(ds)) {
    const j = med(ds, n, "identity", "local", "json", "mem_held"), p = med(ds, n, "identity", "local", "packmem", "mem_held");
    console.log(`| ${ds} | ${n0(n)} | ${mb(j)} | ${mb(p)} | ${ratio(j, p)} | ${ms(med(ds, n, "identity", "local", "packmem", "wasm_init_ms"))} |`);
  }
console.log(`\nMemory measured with ${[...new Set(runs.map((r) => r.mem_how))].join(", ")}.`);
}
