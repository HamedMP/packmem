import { test } from "node:test";
import assert from "node:assert/strict";
import * as pm from "../index.js";

const url = process.env.PACKMEM_PG_URL;
const skip = !url && "set PACKMEM_PG_URL to run the Postgres tests";

// what a plain object-mode query gives, after the same JSON round trip packmem applies
const viaJson = (rows) => JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));

test("fromPg matches object rows from node-postgres", { skip }, async () => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`create temp table t (
      id int, big int8, f float8, n numeric(10,2), s text, b bool, ts timestamptz, j jsonb, missing text)`);
    await client.query(`insert into t
      select i, i::int8 * 10000000000, i / 7.0, i * 1.25, 'row ' || (i % 13), i % 3 = 0,
             timestamptz '2026-01-01 00:00:00+00' + i * interval '1 minute',
             case when i % 5 = 0 then jsonb_build_object('k', i, 'tags', jsonb_build_array('a', 'b')) end,
             null
      from generate_series(1, 25000) as i`);
    const sql = "select * from t order by id";
    const want = viaJson((await client.query(sql)).rows);
    const got = await pm.fromPg(client, sql, [], { batch: 4000 });
    assert.equal(got.length, want.length);
    assert.deepEqual([...got], want);
    assert.equal(got.count({ b: true }), want.filter((r) => r.b).length);
    assert.equal(got.sum("id", { s: "row 3" }), want.filter((r) => r.s === "row 3").reduce((a, r) => a + r.id, 0));

    const arrayMode = await client.query({ text: sql, rowMode: "array" });
    assert.deepEqual([...pm.fromPgResult(arrayMode)], want);
    assert.deepEqual([...pm.fromPgResult(await client.query("select id, s from t where id <= 10 order by id"))].length, 10);

    const empty = await pm.fromPg(client, "select * from t where false");
    assert.equal(empty.length, 0);
    await assert.rejects(pm.fromPg(client, "select * from no_such_table"), /no_such_table/);
  } finally {
    await client.end();
  }
});
