// Run from a directory where the packed packmem tarball is installed: loads the platform's addon and exercises the API.
import assert from "node:assert/strict";
import * as pm from "packmem";

const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, k: i % 3 ? "a" : "b", v: i / 4, s: i % 7 === 0 ? "\udd56" : `r${i}` }));
const t = new pm.Table(rows);
assert.equal(t.length, rows.length);
assert.equal(t.count({ k: "b" }), rows.filter((r) => r.k === "b").length);
assert.equal(t.sum("v", { k: "a" }), rows.filter((r) => r.k === "a").reduce((s, r) => s + r.v, 0));
assert.equal(t.jsonBuffer().toString(), JSON.stringify(rows));
t.sort({ key: "v", descending: true });
assert.equal(t.at(0).id, rows.length - 1);
let lazy = 0;
for (const r of t.lazy()) lazy += r.id;
assert.equal(lazy, rows.reduce((s, r) => s + r.id, 0));
assert.deepEqual([...pm.parseCsv('a,b\n1,"x, y"\n')], [{ a: 1, b: "x, y" }]);
console.log(`packmem ok on ${process.platform}-${process.arch}`);
