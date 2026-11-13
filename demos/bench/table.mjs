// Prints the README results table for one results file: node table.mjs results/darwin-arm64.json
import { readFileSync } from "node:fs";

const { machine, results } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const FW = [["express", "Express"], ["nextjs", "Next.js"], ["fastapi", "FastAPI"]].filter(([f]) => results.some((r) => r.framework === f));
const get = (f, m) => results.find((r) => r.framework === f && r.mode === m);
const nf = new Intl.NumberFormat("en-US");
const n = (v) => (v >= 100 ? nf.format(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

const head = ["", ...FW.flatMap(([, l]) => [`${l} baseline`, `${l} packmem`])];
const rows = [
  ["RSS 1 s after load, MB", (r) => nf.format(r.rss_after_load_mb)],
  ["Idle RSS, settled, MB", (r) => nf.format(r.idle_rss_mb)],
  ["Peak RSS during the run, MB", (r) => nf.format(r.peak_rss_mb)],
  ["Load, ms", (r) => nf.format(r.load_ms)],
  ...get(FW[0][0], "baseline").endpoints.map((e, i) => [`${e.name[0].toUpperCase()}${e.name.slice(1)}, ${e.wall ? "wall " : ""}ms`, (r) => n(r.endpoints[i].median_ms)]),
];
const same = results.every((r) => r.endpoints.every((e, i) => e.hash === get(r.framework, "baseline").endpoints[i].hash));

const earlier = machine.merged_from_earlier_run;
const startLoads = FW.map(([f, l]) => {
  const xs = results.filter((r) => r.framework === f).map((r) => r.loadavg_at_start).filter((x) => x !== undefined);
  if (xs.length) return `${l} ${Math.min(...xs)} to ${Math.max(...xs)}`;
  // runs recorded before per-run load averages existed: use the whole run's before/after values
  const m = earlier ?? machine;
  return m.loadavg_before ? `${l} ${m.loadavg_before[0]} to ${m.loadavg_after[0]}` : null;
}).filter(Boolean);
const loadNote = startLoads.length ? `1-minute load average at the start of each run: ${startLoads.join(", ")}` : `load average ${machine.loadavg_before?.[0]} before and ${machine.loadavg_after?.[0]} after`;
const merged = machine.merged_from_earlier_run ? " Some frameworks were re-run separately and merged into this file." : "";
console.log(`Source: ${machine.source ?? "file"}. ${machine.cpu}, ${machine.cores} cores, Node ${machine.node}; ${loadNote}.${merged} ${same ? "Every response was identical between modes." : "SOME RESPONSES DIFFERED BETWEEN MODES."}\n`);
console.log(`| ${head.join(" | ")} |`);
console.log(`| ${head.map(() => "---").join(" | ")} |`);
for (const [label, f] of rows) console.log(`| ${label} | ${FW.flatMap(([fw]) => [f(get(fw, "baseline")), f(get(fw, "packmem"))]).join(" | ")} |`);
