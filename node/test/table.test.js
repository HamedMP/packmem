import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pm from "../index.js";

// deterministic generator: 40,000 rows crosses two 16,384-row chunks and leaves an open tail
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function makeRows(n, seed = 7) {
  const r = rng(seed);
  const carriers = ["UA", "AA", "DL", "B6", "WN"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = {
      id: i,
      carrier: carriers[Math.floor(r() * carriers.length)],
      delay: r() < 0.05 ? null : Math.round((r() * 200 - 20) * 10) / 10 + 0, // + 0: JSON has no -0
      dist: Math.floor(r() * 3000),
      path: `/api/v${1 + Math.floor(r() * 3)}/item/${Math.floor(r() * 500)}`,
      ok: r() < 0.7,
    };
    if (r() < 0.1) row.note = r() < 0.5 ? 'quote " and \\ backslash' : "unicode é 😀\n";
    if (r() < 0.02) row.tags = ["a", { b: 1 }];
    out.push(row);
  }
  return out;
}

const N = 40_000;
const model = makeRows(N);
const table = new pm.Table(model);

test("iteration, at and slice return the same records", () => {
  assert.equal(table.length, N);
  assert.deepEqual([...table], model);
  assert.deepEqual(table.at(0), model[0]);
  assert.deepEqual(table.at(-1), model[N - 1]);
  assert.equal(table.at(N), undefined);
  assert.deepEqual(table.slice(16_380, 16_390), model.slice(16_380, 16_390));
});

test("JSON output is byte-identical to JSON.stringify", () => {
  assert.equal(table.jsonBuffer().toString(), JSON.stringify(model));
  const v = table.where({ carrier: "UA" });
  assert.equal(v.jsonBuffer().toString(), JSON.stringify(model.filter((m) => m.carrier === "UA")));
  assert.equal(JSON.stringify(table.where({ carrier: "nope" }).toArray()), "[]");
  assert.equal(table.where({ carrier: "nope" }).jsonBuffer().toString(), "[]");
});

test("filters match Array.filter", () => {
  const cases = [
    [{ carrier: "DL" }, (m) => m.carrier === "DL"],
    [{ delay: { gt: 60 } }, (m) => typeof m.delay === "number" && m.delay > 60],
    [{ delay: { between: [0, 10] } }, (m) => typeof m.delay === "number" && m.delay >= 0 && m.delay <= 10],
    [{ dist: { lt: 100 }, ok: true }, (m) => m.dist < 100 && m.ok === true],
    [{ path: { prefix: "/api/v2/" } }, (m) => m.path.startsWith("/api/v2/")],
    [{ path: { contains: "/item/42" } }, (m) => m.path.includes("/item/42")],
    [{ delay: null }, (m) => m.delay === null],
    [{ missing_col: 1 }, () => false],
  ];
  for (const [f, pred] of cases) {
    const want = model.filter(pred);
    assert.equal(table.count(f), want.length, JSON.stringify(f));
    assert.deepEqual(table.where(f).rows(), want, JSON.stringify(f));
  }
  assert.deepEqual(
    table.where({ carrier: "AA" }).where({ ok: false }).rows({ offset: 3, limit: 5 }),
    model.filter((m) => m.carrier === "AA" && !m.ok).slice(3, 8),
  );
});

test("sum and groupCount match plain loops", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
  assert.equal(table.sum("dist"), model.reduce((s, m) => s + m.dist, 0));
  close(table.sum("delay"), model.reduce((s, m) => s + (m.delay ?? 0), 0));
  assert.equal(
    table.sum("dist", { carrier: "B6" }),
    model.filter((m) => m.carrier === "B6").reduce((s, m) => s + m.dist, 0),
  );
  const want = {};
  for (const m of model) want[m.carrier] = (want[m.carrier] ?? 0) + 1;
  assert.deepEqual(table.groupCount("carrier"), want);
  assert.deepEqual(table.column("dist", { carrier: "WN" }), model.filter((m) => m.carrier === "WN").map((m) => m.dist));
});

test("push, set and update write through", () => {
  const t = new pm.Table(model.slice(0, 20_000));
  const m = model.slice(0, 20_000).map((r) => ({ ...r }));
  t.push({ id: -1, carrier: "ZZ", extra: 5 });
  m.push({ id: -1, carrier: "ZZ", extra: 5 });
  t.update(3, { carrier: "XX", delay: undefined });
  m[3].carrier = "XX";
  delete m[3].delay;
  t.set(17_000, { id: 99, carrier: "YY" });
  m[17_000] = { id: 99, carrier: "YY" };
  for (const i of [3, 17_000, 20_000]) assert.deepEqual(t.at(i), m[i]);
  assert.equal(t.count({ carrier: "XX" }), 1);
  assert.equal(t.count({ extra: 5 }), 1);
  assert.throws(() => t.update(10 ** 6, { a: 1 }), RangeError);
});

test("parse and load read JSON lines and arrays", () => {
  const dir = mkdtempSync(join(tmpdir(), "packmem-"));
  const small = model.slice(0, 1000);
  const jl = join(dir, "a.jsonl");
  const ja = join(dir, "a.json");
  writeFileSync(jl, small.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(ja, JSON.stringify(small));
  assert.deepEqual([...pm.loadJsonl(jl)], small);
  assert.deepEqual([...pm.loadJson(ja)], small);
  assert.deepEqual([...pm.parse(readFileSync(ja))], small);
  assert.deepEqual([...pm.parse(readFileSync(jl, "utf8"))], small);
  assert.throws(() => pm.parse('{"a":1}\n{"a":'), /line 2/);
});

test("streams produce the same bytes as jsonBuffer", async () => {
  const v = table.where({ ok: false });
  const parts = [];
  for await (const c of v.jsonStream({ batch: 1000 })) parts.push(c);
  assert.equal(Buffer.concat(parts).toString(), v.jsonBuffer().toString());
  const text = await new Response(v.jsonWebStream()).text();
  assert.equal(text, v.jsonBuffer().toString());
});

const flights = new URL("../../data/flights.jsonl", import.meta.url).pathname;
test("real flight data matches JSON.parse", { skip: !existsSync(flights) }, () => {
  const raw = readFileSync(flights, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const t = pm.loadJsonl(flights);
  assert.equal(t.length, raw.length);
  assert.equal(t.jsonBuffer().toString(), JSON.stringify(raw));
  assert.equal(t.count({ carrier: "UA" }), 58_665);
  assert.equal(t.sum("distance", { origin: "JFK" }), 140_906_931);
});
