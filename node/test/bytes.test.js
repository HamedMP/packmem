// The byte form: written by any binding, read back by any other with the same rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Table } from "../index.js";

const rows = Array.from({ length: 20_000 }, (_, i) => {
  const r = { id: i, k: ["b", "a", "c"][i % 3], v: ((i * 7919) % 1000) / 8, s: i % 11 === 0 ? "x\udd56é" : `r${i % 50}` };
  if (i % 5 === 0) r.note = i % 10 === 0 ? null : { n: i, tags: ["a", 1.5] };
  r.turns = i % 7 === 0 ? [] : [{ from: "human", value: `q${i}` }, { from: "gpt", value: "a".repeat(i % 90) }];
  return r;
});
const json = (t) => new TextDecoder().decode(t.jsonBuffer());

test("toBytes and fromBytes give the same table", () => {
  const t = new Table(rows.slice(0, 15_000));
  const view = t.where({ k: "a" });
  const before = view.rows({ limit: 5 });
  t.push(...rows.slice(15_000)); // open rows, packed by toBytes
  const b = t.toBytes();
  assert.ok(b instanceof Uint8Array);
  const back = Table.fromBytes(b);
  assert.equal(json(back), json(t));
  assert.deepEqual(back.describe(), t.describe());
  assert.deepEqual(view.rows({ limit: 5 }), before, "a view made before toBytes still reads the same rows");
  assert.equal(view.length, t.count({ k: "a" }));
  back.push({ id: -1 });
  assert.equal(back.length, t.length + 1, "a table read from bytes is writable");
  assert.deepEqual(Table.fromBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).at(-1), t.at(-1));
});

test("a shared table writes the same bytes", () => {
  const t = new Table(rows);
  const b = t.toBytes();
  t.share();
  assert.deepEqual(t.toBytes(), b);
  t.unshare();
});

test("bytes that are not a table are refused", () => {
  assert.throws(() => Table.fromBytes(new Uint8Array([1, 2, 3, 4, 5])), /not packed table data/);
  const b = new Table(rows.slice(0, 100)).toBytes();
  assert.throws(() => Table.fromBytes(b.subarray(0, b.length - 3)));
});

const wasmFile = new URL("../wasm-dist/packmem_bg.wasm", import.meta.url);
test("the WebAssembly build and the addon read each other's bytes", {
  skip: !existsSync(wasmFile) && "build it first: node scripts/build-wasm.mjs",
}, async () => {
  const { init } = await import("../wasm.js");
  const wasm = await init(readFileSync(wasmFile));
  const t = new Table(rows);
  const w = wasm.Table.fromBytes(t.toBytes());
  assert.equal(json(w), json(t));
  assert.equal(json(Table.fromBytes(w.toBytes())), json(t));
});

// Set PACKMEM_PYTHON to an interpreter with packmem built from this tree (the byte form is tied to the version).
const python = process.env.PACKMEM_PYTHON;
test("bytes written by Python read the same in Node", { skip: !python && "set PACKMEM_PYTHON" }, () => {
  const script = `import json, sys, packmem
t = packmem.Table(json.loads(sys.stdin.read()))
sys.stdout.buffer.write(t.to_bytes())`;
  const fromPy = execFileSync(python, ["-c", script], { input: JSON.stringify(rows), maxBuffer: 1 << 28 });
  const t = Table.fromBytes(fromPy);
  assert.equal(t.length, rows.length);
  assert.deepEqual(t.slice(0, 50), rows.slice(0, 50));
  assert.deepEqual(t.at(-1), rows.at(-1));
  assert.ok(t.describe().find((c) => c.name === "turns").encoding.startsWith("list<"), "the turns stay sub-columns");
  const roundTrip = `import sys, packmem
sys.stdout.buffer.write(packmem.Table.from_bytes(sys.stdin.buffer.read()).to_json())`;
  assert.deepEqual(JSON.parse(execFileSync(python, ["-c", roundTrip], { input: t.toBytes(), maxBuffer: 1 << 28 })), JSON.parse(json(t)));
});
