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

console.log(`Source: ${machine.source ?? "file"}. ${machine.cpu}, ${machine.cores} cores, Node ${machine.node}, load average ${machine.loadavg_before?.[0]} before and ${machine.loadavg_after?.[0]} after. ${same ? "Every response was identical between modes." : "SOME RESPONSES DIFFERED BETWEEN MODES."}\n`);
console.log(`| ${head.join(" | ")} |`);
console.log(`| ${head.map(() => "---").join(" | ")} |`);
for (const [label, f] of rows) console.log(`| ${label} | ${FW.flatMap(([fw]) => [f(get(fw, "baseline")), f(get(fw, "packmem"))]).join(" | ")} |`);
