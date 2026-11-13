import { test } from "node:test";
import assert from "node:assert/strict";
import * as pm from "../index.js";

// 40,000 rows spans two packed chunks and an open tail
const make = (n) =>
  Array.from({ length: n }, (_, i) => {
    const r = { id: i, k: ["b", "a", "c"][i % 3], v: (i * 7919) % 1000 };
    if (i % 5 === 0) r.note = i % 10 === 0 ? null : `n${i}`;
    return r;
  });

test("splice, insert, pop, shift, unshift and reverse match an array", () => {
  const arr = make(40_000);
  const t = new pm.Table(arr);
  assert.deepEqual(t.splice(16_380, 10, { id: -1 }, { id: -2 }), arr.splice(16_380, 10, { id: -1 }, { id: -2 }));
  assert.deepEqual(t.splice(-3), arr.splice(-3));
  assert.deepEqual(t.splice(5, 0), arr.splice(5, 0));
  assert.equal(t.insert(0, { id: "first" }), (arr.splice(0, 0, { id: "first" }), arr.length));
  assert.deepEqual(t.pop(), arr.pop());
  assert.deepEqual(t.shift(), arr.shift());
  assert.equal(t.unshift({ id: "u1" }, { id: "u2" }), arr.unshift({ id: "u1" }, { id: "u2" }));
  t.reverse();
  arr.reverse();
  assert.deepEqual([...t], arr);
  assert.equal(new pm.Table().pop(), undefined);
});

test("sort by column and by compare function is stable and matches Array.prototype.sort", () => {
  const arr = make(40_000);
  const t = new pm.Table(arr);
  t.sort({ key: "k" });
  assert.deepEqual([...t], [...arr].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)));
  t.sort({ key: "v", descending: true });
  assert.deepEqual(
    t.column("id"),
    [...arr].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).sort((a, b) => b.v - a.v).map((r) => r.id),
  );
  const u = new pm.Table(arr);
  u.sort((a, b) => a.v - b.v || b.id - a.id);
  assert.deepEqual([...u], [...arr].sort((a, b) => a.v - b.v || b.id - a.id));
  // missing and null keys sort last
  const w = new pm.Table([{ x: 2 }, {}, { x: null }, { x: 1 }]);
  w.sort({ key: "x" });
  assert.deepEqual([...w], [{ x: 1 }, { x: 2 }, { x: null }, {}]);
  assert.throws(() => w.sort(), TypeError);
});

test("take, copy and clear", () => {
  const arr = make(1000);
  const t = new pm.Table(arr);
  assert.deepEqual([...t.take([5, 1, 5])], [arr[5], arr[1], arr[5]]);
  const c = t.copy();
  c.update(0, { k: "z" });
  assert.equal(t.at(0).k, "b");
  assert.throws(() => t.take([5000]), /out of range/);
  t.clear();
  assert.equal(t.length, 0);
  t.push({ a: 1 });
  assert.deepEqual([...t], [{ a: 1 }]);
});

test("views recompute after list operations", () => {
  const t = new pm.Table(make(100));
  const v = t.where({ k: "a" });
  const before = v.length;
  t.splice(0, 30);
  assert.equal(v.length, t.toArray().filter((r) => r.k === "a").length);
  assert.notEqual(v.length, before);
});

test("lazy rows read fields on demand and write back", () => {
  const arr = make(10_000);
  const t = new pm.Table(arr);
  let sum = 0;
  let i = 0;
  for (const r of t.lazy()) {
    sum += r.v;
    assert.equal(r.note, arr[i].note); // undefined where the key is missing, null where it is null
    assert.equal("note" in arr[i] ? r.get("note") : undefined, arr[i].note);
    i++;
  }
  assert.equal(sum, arr.reduce((s, r) => s + r.v, 0));
  for (const r of t.lazy()) if (r.id === 7) r.k = "changed";
  assert.equal(t.at(7).k, "changed");
  const first = t.lazy().next().value;
  assert.deepEqual(first.toObject(), arr[0]);
  assert.equal(JSON.stringify(first), JSON.stringify(arr[0]));
  assert.equal(first.index, 0);
});
