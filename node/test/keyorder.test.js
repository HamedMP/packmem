// keepKeyOrder: rows read back with their keys as written, and the hidden column that holds the orders stays hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Table, loadJson, loadJsonl, parse } from "../index.js";

const SHAPES = [
  ["type", "uuid", "message", "cwd"],
  ["cwd", "type", "message"],
  ["message", "uuid", "type", "extra", "cwd"],
  ["uuid", "type"],
];
// more than one 16,384-row chunk, so packed rows and open rows are both read
const lines = Array.from({ length: 40_000 }, (_, i) => {
  const r = {};
  for (const k of SHAPES[(i * 7) % SHAPES.length]) {
    r[k] = k === "message" ? { role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: `t${i % 97}` }] } : k === "extra" ? i : `${k}-${i % 13}`;
  }
  return JSON.stringify(r);
});
const text = (t) => [...t].map((r) => JSON.stringify(r));

test("rows keep their key order through every loader and through toBytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-keyorder-"));
  try {
    writeFileSync(join(dir, "a.jsonl"), lines.join("\n") + "\n");
    writeFileSync(join(dir, "a.json"), `[${lines.join(",")}]`);
    const opts = { keepKeyOrder: true };
    for (const threads of ["0", "2"]) {
      process.env.PACKMEM_LOAD_THREADS = threads;
      assert.deepEqual(text(loadJsonl(join(dir, "a.jsonl"), opts)), lines, `loadJsonl, ${threads} threads`);
      assert.deepEqual(text(loadJson(join(dir, "a.json"), opts)), lines, `loadJson, ${threads} threads`);
    }
    delete process.env.PACKMEM_LOAD_THREADS;
    const t = parse(lines.join("\n"), opts);
    assert.deepEqual(text(t), lines);
    assert.deepEqual(text(new Table(lines.map((l) => JSON.parse(l)), opts)), lines);
    assert.deepEqual(t.names, ["type", "uuid", "message", "cwd", "extra"]);
    assert.ok(!t.names.some((n) => n.includes("\0")));
    const b = t.toBytes();
    assert.equal(b[4], 6, "a table that keeps key orders is written as format 6");
    assert.deepEqual(text(Table.fromBytes(b)), lines);
    assert.deepEqual(Table.fromBytes(b).names, t.names);
    assert.equal(parse(lines.join("\n")).toBytes()[4], 5, "every other table is still format 5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without the option rows come back in column order, as before", () => {
  const t = parse(lines.slice(0, 4).join("\n"));
  assert.deepEqual(Object.keys(JSON.parse(lines[1])), ["uuid", "type"]);
  assert.deepEqual(Object.keys(t.at(1)), ["type", "uuid"]);
});

test("edits and list operations keep each row's order", () => {
  const u = new Table(undefined, { keepKeyOrder: true });
  u.extend(lines.slice(100, 200).map((l) => JSON.parse(l)));
  u.set(3, { zz: 1, type: "q", aa: null });
  u.update(4, { extra: "x" });
  u.update(6, { cwd: undefined });
  u.insert(0, { q: 1, cwd: 2 });
  u.push({ last: 1, type: "t" });
  assert.deepEqual(Object.keys(u.at(4)), ["zz", "type", "aa"]);
  // a key added later goes after the keys the row was written with; a removed key is gone
  assert.deepEqual(Object.keys(u.at(5)), [...Object.keys(JSON.parse(lines[104])), "extra"]);
  assert.deepEqual(Object.keys(u.at(7)), Object.keys(JSON.parse(lines[106])).filter((k) => k !== "cwd"));
  assert.deepEqual(Object.keys(u.at(0)), ["q", "cwd"]);
  assert.deepEqual(Object.keys(u.at(-1)), ["last", "type"]);
  u.reverse();
  assert.deepEqual(Object.keys(u.at(0)), ["last", "type"]);
  assert.deepEqual(Object.keys(u.take([0]).at(0)), ["last", "type"]);
  u.sort({ key: "type" });
  assert.ok(!u.names.some((n) => n.includes("\0")));
  for (const r of u) assert.ok(!Object.keys(r).some((k) => k.includes("\0")));
  u.clear();
  u.push({ b: 1, a: 2 });
  assert.deepEqual(Object.keys(u.at(0)), ["b", "a"], "clear keeps the option");
  const empty = new Table(undefined, { keepKeyOrder: true }).take([]);
  empty.push({ b: 1, a: 2 }, { a: 3, b: 4 });
  assert.deepEqual(text(empty), ['{"b":1,"a":2}', '{"a":3,"b":4}'], "a copy made before any row keeps the option");
});

test("a table Python saved with keep_key_order reads with its keys as written", () => {
  const keyed = readFileSync(new URL("../../python/tests/fixtures/table_key_order.pkm", import.meta.url));
  const k = Table.fromBytes(keyed);
  assert.deepEqual(k.slice(0, 3).map((r) => Object.keys(r)), [["b", "a"], ["a", "b"], ["c", "a"]]);
  assert.deepEqual(k.names, ["b", "a", "c"]);
});

test("the compact and archive hints read back the same rows", () => {
  const want = lines.slice(0, 20_000);
  const base = parse(want.join("\n"));
  for (const hint of ["compact", "archive"]) {
    const t = parse(want.join("\n"), { hint, keepKeyOrder: true });
    assert.deepEqual(text(t), want, hint);
    assert.deepEqual(text(Table.fromBytes(t.toBytes())), want, `${hint} through toBytes`);
    assert.ok(t.toBytes().length < base.toBytes().length, `${hint} is smaller than balanced`);
  }
  assert.throws(() => new Table(undefined, { hint: "tiny" }), /'compact' or 'archive'/);
});
