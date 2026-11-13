import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pm from "../index.js";

test("CSV: quoting, types, empty fields and TSV", () => {
  const text = 'id,name,score,zip\r\n1,"Smith, J",9.5,007\r\n2,"say ""hi""",,10115\r\n';
  assert.deepEqual([...pm.parseCsv(text)], [
    { id: 1, name: "Smith, J", score: 9.5, zip: "007" },
    { id: 2, name: 'say "hi"', score: "", zip: 10115 },
  ]);
  assert.equal(pm.parseCsv(text, { emptyIsNull: true }).at(1).score, null);
  const typed = [...pm.parseCsv(text, { types: ["text", "text", "float", "text"] })];
  assert.deepEqual(typed[0], { id: "1", name: "Smith, J", score: 9.5, zip: "007" });
  assert.equal(typed[1].score, null); // empty in a typed column is null
  const dir = mkdtempSync(join(tmpdir(), "packmem-csv-"));
  writeFileSync(join(dir, "a.tsv"), "x\ty\n1\ta b\n2\tc\n");
  assert.deepEqual([...pm.loadTsv(join(dir, "a.tsv"))], [{ x: 1, y: "a b" }, { x: 2, y: "c" }]);
  assert.deepEqual([...pm.parseCsv("1,2\n", { header: false, names: ["a", "b"] })], [{ a: 1, b: 2 }]);
  assert.throws(() => pm.parseCsv("a,b\n1\n"), /line 2: 1 fields for 2 columns/);
  assert.throws(() => pm.parseCsv('a\n"open'), /unterminated/);
  assert.throws(() => pm.parseCsv("a\nx\n", { types: ["int"] }), Error);
});

const flights = new URL("../../data/flights.csv", import.meta.url).pathname;
test("flights.csv loads to the same records as flights.jsonl", { skip: !existsSync(flights) }, () => {
  const fromCsv = pm.loadCsv(flights, { emptyIsNull: true });
  const fromJson = pm.loadJsonl(new URL("../../data/flights.jsonl", import.meta.url));
  assert.equal(fromCsv.length, fromJson.length);
  assert.equal(fromCsv.jsonBuffer().toString(), fromJson.jsonBuffer().toString());
});
