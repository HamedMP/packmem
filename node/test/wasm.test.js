// The WebAssembly build must behave exactly like the Node addon: same operations, same results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import * as native from "../index.js";

const wasmFile = new URL("../wasm-dist/packmem_bg.wasm", import.meta.url);
const skip = !existsSync(wasmFile) && "build it first: node scripts/build-wasm.mjs";

const rows = Array.from({ length: 40_000 }, (_, i) => {
  const r = { id: i, k: ["b", "a", "c"][i % 3], v: (i * 7919) % 1000 / 8, s: i % 11 === 0 ? "x\udd56" : `r${i % 50}` };
  if (i % 5 === 0) r.note = i % 10 === 0 ? null : { n: i, tags: ["a", 1.5] };
  return r;
});

test("wasm and native give identical results", { skip }, async () => {
  const { init } = await import("../wasm.js");
  const wasm = await init(readFileSync(wasmFile));
  const run = (pm) => {
    const t = new pm.Table(rows);
    const out = {};
    out.json = new TextDecoder().decode(t.jsonBuffer());
    out.count = t.count({ k: "a", v: { gte: 10, lt: 100 } });
    out.prefix = t.where({ s: { prefix: "r1" } }).rows({ offset: 3, limit: 7 });
    out.sum = t.sum("v", { k: "c" });
    out.groups = { ...t.groupCount("s", { k: "b" }) };
    out.column = t.column("note", { id: { lt: 30 } });
    t.sort({ key: "v", descending: true });
    t.splice(16_000, 500, { id: -1, k: "z" });
    out.afterOps = t.slice(15_995, 16_005);
    let lazy = 0;
    for (const r of t.lazy()) lazy += typeof r.v === "number" ? r.v : 0;
    out.lazy = lazy;
    out.csv = [...pm.parseCsv('a,b\n1,"x, ""y"""\n007,\n', { emptyIsNull: true })];
    out.parsed = [...pm.parse(rows.slice(0, 50).map((r) => JSON.stringify(r)).join("\n"))];
    out.err = (() => {
      try {
        pm.parse('{"a":1}\n{"a":');
      } catch (e) {
        return String(e.message);
      }
    })();
    return out;
  };
  const a = run(native);
  const b = run(wasm);
  for (const k of Object.keys(a)) assert.deepEqual(b[k], a[k], k);
});
