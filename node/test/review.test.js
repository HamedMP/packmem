// Regression tests for the findings of the November 2026 review.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as pm from "../index.js";

const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, k: i % 3 === 0 ? "a" : "b", v: i / 2 }));

test("negative and non-numeric offset/limit are clamped, never wrap", () => {
  const v = new pm.Table(rows).where({});
  assert.equal(v.rows({ limit: -5 }).length, 0);
  assert.deepEqual(v.rows({ offset: -10, limit: 2 }), rows.slice(0, 2));
  assert.deepEqual(v.rows({ offset: "20", limit: "3" }), rows.slice(20, 23));
  assert.deepEqual(v.rows({ offset: "x", limit: "y" }), rows);
  assert.equal(JSON.parse(v.rowsJsonBuffer({ limit: -1 })).length, 0);
});

test("out-of-range or unordered row ids raise errors instead of crashing", () => {
  const t = new pm.Table(rows);
  const v = t.where({ k: "a" });
  v.ids[0] = 4_000_000_000;
  assert.throws(() => v.sum("id"), /out of range/);
  assert.throws(() => v.groupCount("k"), /out of range/);
  assert.throws(() => v.column("id"), /out of range/);
  assert.throws(() => v.rows(), /out of range/);
  assert.throws(() => t._t.select("[]", new Uint32Array([3, 1])), /increasing/);
  assert.throws(() => t._t.setJson(0, "k", '"'), /not a JSON value/);
});

test("groupCount keys cannot collide with Object.prototype", () => {
  const t = new pm.Table([{ k: "constructor" }, { k: "__proto__" }, { k: "toString" }, { k: "constructor" }]);
  const g = t.groupCount("k");
  assert.equal(g.constructor, 2);
  assert.equal(g.__proto__, 1);
  assert.equal(g.toString, 1);
  assert.equal(Object.keys(g).length, 3);
});

test("appends are all or nothing", () => {
  const t = new pm.Table(rows);
  const before = [...t];
  assert.throws(() => t.push({ a: 1 }, null), TypeError);
  assert.throws(() => t.push(undefined), TypeError);
  assert.throws(() => t.extend([{ a: 1 }, { d: new Date(Number.NaN), x: 1n }]), TypeError);
  assert.throws(() => t.extend([{ a: 1n }]), TypeError);
  assert.throws(() => t.extendArrays(["a"], [[1], "x"]), TypeError);
  assert.deepEqual([...t], before);
  // a failed append that crossed a chunk boundary is rolled back too
  const big = new pm.Table();
  assert.throws(() => big.extend((function* () { for (let i = 0; i < 40_000; i++) yield { i }; yield 5; })()));
  assert.equal(big.length, 0);
  big.push({ i: 1 });
  assert.deepEqual([...big], [{ i: 1 }]);
});

test("update is all or nothing", () => {
  const t = new pm.Table([{ a: 1, b: 2 }]);
  assert.throws(() => t.update(0, { a: 5, s: 1n }), TypeError);
  assert.deepEqual(t.at(0), { a: 1, b: 2 });
  t.update(0, { a: 5, b: undefined });
  assert.deepEqual(t.at(0), { a: 5 });
});

test("NaN and infinite filter values behave like JavaScript comparisons", () => {
  const t = new pm.Table(rows);
  assert.throws(() => t.count({ v: { gt: NaN } }), TypeError);
  assert.throws(() => t.count({ v: { between: [0, NaN] } }), TypeError);
  assert.throws(() => t.count({ k: { prefix: 5 } }), TypeError);
  assert.equal(t.count({ v: NaN }), 0);
  assert.equal(t.count({ v: Infinity }), 0);
  assert.equal(t.count({ v: { gt: -Infinity } }), rows.length);
  assert.equal(t.count({ v: { lt: Infinity, gte: 10 } }), rows.filter((r) => r.v >= 10).length);
});

test("numbers are written exactly as JSON.stringify writes them", () => {
  const nums = [1e-6, 1e-7, 1.5e-7, 0.1 + 0.2, 1e15, 1e16 + 2, 1e18, 1e21, 1.5e21, 123456789012345680000, -0, -1e-300, 5e-324, 1.7976931348623157e308, -2.5, 100, 1 / 3];
  const recs = nums.map((x) => ({ x, y: x * 3.7 }));
  assert.equal(new pm.Table(recs).jsonBuffer().toString(), JSON.stringify(recs));
});

test("batch sizes are clamped; reduce follows Array.prototype.reduce", () => {
  const t = new pm.Table(rows);
  assert.equal(JSON.parse(Buffer.concat([...t.jsonChunks({ batch: 0 })])).length, rows.length);
  assert.equal(JSON.parse(Buffer.concat([...t.jsonChunks({ batch: -3 })])).length, rows.length);
  assert.equal(t.reduce((a, r) => (typeof a === "object" ? a.id : a) + r.id), rows.reduce((a, r) => (typeof a === "object" ? a.id : a) + r.id));
  assert.throws(() => new pm.Table().reduce((a, b) => a + b), TypeError);
  assert.equal(new pm.Table().reduce((a) => a, 7), 7);
});

test("a view recomputes its matches after the table changes", () => {
  const t = new pm.Table(rows);
  const v = t.where({ k: "a" });
  const n = v.length;
  t.push({ id: 99, k: "a" });
  assert.equal(v.length, n + 1);
  t.update(0, { k: "b" });
  assert.equal(v.length, n);
  const w = v.where({ id: { gte: 90 } });
  assert.deepEqual(w.rows(), [{ id: 99, k: "a" }]);
});

test("lone UTF-16 surrogates round-trip as JSON.parse reads them", () => {
  // VS Code's trace files contain strings like "\udd56" that JSON.parse accepts but no UTF-8 text can hold
  const recs = [
    { s: "\udd56", n: 1 },
    { s: "a\ud800b", n: 2, nested: { t: "\udfff", list: ["\ud83d", "ok"] } }, // keys in column order: output follows first-seen order
    { s: "\ud83d\ude00 paired is fine", n: 3 },
  ];
  const json = recs.map((r) => JSON.stringify(r)).join("\n");
  for (const t of [pm.parse(json), new pm.Table(recs), pm.parse(JSON.stringify(recs))]) {
    assert.deepEqual([...t], recs);
    assert.equal(t.jsonBuffer().toString(), JSON.stringify(recs));
    assert.equal(t.count({ n: { gte: 1 } }), 3);
  }
  const t = new pm.Table(recs);
  t.update(2, { s: "\udc00" });
  assert.equal(t.at(2).s, "\udc00");
  const a = new pm.Table().extendArrays(["s"], [["\ud800"], ["x"]]);
  assert.deepEqual([...a], [{ s: "\ud800" }, { s: "x" }]);
});

test("load errors name the record's position in the whole input", () => {
  const t = new pm.Table();
  const rows = Array.from({ length: 5000 }, (_, i) => [i]);
  assert.throws(() => t.extendArrays(["a", "b"], rows), /^Error: record 0: 1 values for 2 columns/);
  const ok = rows.map((r) => [r[0], 1]);
  ok[4100] = [1];
  assert.throws(() => t.extendArrays(["a", "b"], ok), /record 4100: 1 values for 2 columns/);
  assert.equal(t.length, 0);
});
