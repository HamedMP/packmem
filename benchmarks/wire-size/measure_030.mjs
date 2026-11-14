// What a released packmem itself writes (0.3.0: format 4, varint headers), for the same records and sizes as the
// probe, next to the probe's format-3 sizes. usage:
//   node measure_030.mjs <dir holding node_modules/packmem> <data dir> <bytes dir> <size,...> <probe.jsonl> [label]
// Prints one line per dataset and size in the probe's shape, for compress.py. The label (default v<version>) names
// the build, so an unreleased main build is never mistaken for the release.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [pmDir, dataDir, bytesDir, sizes, probeFile, label] = process.argv.slice(2);
const require = createRequire(resolve(pmDir, "package.json"));
const version = require("packmem/package.json").version;
const { parse } = await import(pathToFileURL(require.resolve("packmem")).href);
const probe = new Map(
  readFileSync(probeFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => [`${r.dataset}-${r.rows}-${r.mode}`, r.bytes]),
);
mkdirSync(bytesDir, { recursive: true });
for (const name of ["flights", "chat", "issues", "traces", "logs"]) {
  const lines = readFileSync(join(dataDir, `${name}.jsonl`), "utf8").split("\n").filter(Boolean);
  for (const n of sizes.split(",").map(Number)) {
    if (n > lines.length) continue;
    const b = parse(lines.slice(0, n).join("\n")).toBytes();
    const mode = label ?? `v${version}`;
    writeFileSync(join(bytesDir, `${name}-${n}-${mode}.pkm`), b);
    console.log(
      JSON.stringify({
        dataset: name,
        rows: n,
        mode,
        bytes: b.length,
        format: b[4],
        sections: {},
        format3_bytes: probe.get(`${name}-${n}-as_is`),
        probe_varint_headers_bytes: probe.get(`${name}-${n}-varint_headers`),
      }),
    );
  }
}
