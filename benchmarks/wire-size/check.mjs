// The instrumented probe must write, with no variant on, the same bytes as packmem itself (the Node addon built from
// the unmodified source). usage: node check.mjs <packmem node dir> <data dir> <bytes dir> <size,...>
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const [pmDir, dataDir, bytesDir, sizes] = process.argv.slice(2);
const { parse, Table } = await import(join(pmDir, "index.js"));
let bad = 0;
for (const f of readdirSync(dataDir).filter((f) => f.endsWith(".jsonl") && f !== "github_issues.jsonl")) {
  const name = f.replace(".jsonl", "");
  const lines = readFileSync(join(dataDir, f), "utf8").split("\n").filter(Boolean);
  for (const n of sizes.split(",").map(Number)) {
    const file = join(bytesDir, `${name}-${n}-as_is.pkm`);
    if (!existsSync(file)) continue;
    const ours = parse(lines.slice(0, n).join("\n")).toBytes();
    const probe = readFileSync(file);
    const same = Buffer.compare(Buffer.from(ours), probe) === 0;
    const back = Table.fromBytes(probe).length === n;
    if (!same || !back) bad++;
    console.log(`${name} ${n}: ${same ? "identical" : `DIFFERENT (${ours.length} vs ${probe.length})`}, reads back ${back}`);
  }
}
process.exit(bad ? 1 : 0);
