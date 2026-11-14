// File and one-call loaders: nested JSON is kept as written (whitespace between tokens dropped), and packing
// text-heavy chunks on a background thread gives exactly the table a single-threaded load gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pm from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "packmem-load-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const text = (t) => new TextDecoder().decode(t.jsonBuffer());

const LINES = [
  String.raw`{"id":1, "meta": { "a" : [1, 2.50, 1e3, 12345678901234567890], "s": "x\u00e9\/y \"q\" \\ end", "e": {} }, "t":"plain"}`,
  String.raw`{"id":2,"meta":[ ],"t":"tab\tinside"}`,
  String.raw`{"id":3,"meta":{"k":"two  spaces","n":null,"b":true}}`,
];
// whitespace between tokens dropped, everything else (escapes, number text, key order) as written
const COMPACT = String.raw`[{"id":1,"meta":{"a":[1,2.50,1e3,12345678901234567890],"s":"x\u00e9\/y \"q\" \\ end","e":{}},"t":"plain"},{"id":2,"meta":[],"t":"tab\tinside"},{"id":3,"meta":{"k":"two  spaces","n":null,"b":true}}]`;

test("nested JSON is kept as written by every loader", () => {
  const jsonl = join(dir, "nested.jsonl");
  const array = join(dir, "nested.json");
  writeFileSync(jsonl, LINES.join("\n") + "\n");
  writeFileSync(array, "[\n" + LINES.join(",\n") + "\n]\n");
  for (const [how, t] of [
    ["loadJsonl", pm.loadJsonl(jsonl)],
    ["loadJson", pm.loadJson(array)],
    ["parse lines", pm.parse(readFileSync(jsonl))],
    ["parse array", pm.parse(readFileSync(array))],
  ]) {
    assert.equal(text(t), COMPACT, how);
    assert.deepEqual([...t], LINES.map((l) => JSON.parse(l)), how);
  }
});

test("records built in JavaScript still write back as JSON.stringify does", () => {
  const rows = LINES.map((l) => JSON.parse(l));
  assert.equal(text(new pm.Table(rows)), JSON.stringify(rows));
});

test("the WebAssembly build keeps nested JSON the same way", { skip: !existsSync(new URL("../wasm-dist/packmem_bg.wasm", import.meta.url)) }, async () => {
  const { init } = await import("../wasm.js");
  const wasm = await init(readFileSync(new URL("../wasm-dist/packmem_bg.wasm", import.meta.url)));
  assert.equal(new TextDecoder().decode(wasm.parse(LINES.join("\n")).jsonBuffer()), COMPACT);
});

// Three chunks of 16,384 records with about 300 bytes of text each: over the 4 MB of text per chunk at which the core
// hands a chunk to a background thread.
const heavy = Array.from({ length: 3 * 16_384 + 77 }, (_, i) => ({
  id: i,
  messages: [
    { role: "user", content: `question ${i} `.repeat(9) },
    { role: "assistant", content: `answer ${i % 97} `.repeat(14) },
  ],
  tag: ["a", "b", "c"][i % 3],
  score: i % 11 === 0 ? null : (i * 7) % 1000 / 8,
}));

function withThreads(n, f) {
  const before = process.env.PACKMEM_LOAD_THREADS;
  process.env.PACKMEM_LOAD_THREADS = String(n);
  try {
    return f();
  } finally {
    if (before === undefined) delete process.env.PACKMEM_LOAD_THREADS;
    else process.env.PACKMEM_LOAD_THREADS = before;
  }
}

test("loading on a background thread gives the same table as loading on one", () => {
  const jsonl = join(dir, "heavy.jsonl");
  const array = join(dir, "heavy.json");
  writeFileSync(jsonl, heavy.map((r) => JSON.stringify(r)).join("\n"));
  writeFileSync(array, JSON.stringify(heavy));
  const expected = JSON.stringify(heavy);
  for (const threads of [0, 1, 3]) {
    for (const [how, load] of [
      ["loadJsonl", () => pm.loadJsonl(jsonl)],
      ["loadJson", () => pm.loadJson(array)],
      ["parse", () => pm.parse(readFileSync(jsonl))],
    ]) {
      const t = withThreads(threads, load);
      assert.equal(t.length, heavy.length, `${how}, ${threads} threads`);
      assert.equal(text(t), expected, `${how}, ${threads} threads`);
      assert.equal(t.count({ tag: "b" }), heavy.filter((r) => r.tag === "b").length);
      assert.deepEqual(t.at(40_000), heavy[40_000]);
    }
  }
});

test("CSV files load the same with and without a background thread", () => {
  const csv = join(dir, "heavy.csv");
  const body = heavy.map((r) => `${r.id},"${r.messages[0].content}","${r.messages[1].content}",${r.tag}`).join("\n");
  writeFileSync(csv, "id,q,a,tag\n" + body + "\n");
  const one = withThreads(0, () => pm.loadCsv(csv));
  const two = withThreads(1, () => pm.loadCsv(csv));
  assert.equal(one.length, heavy.length);
  assert.equal(text(two), text(one));
  assert.equal(text(two), text(pm.parseCsv(readFileSync(csv))));
});
