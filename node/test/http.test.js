// Tables over HTTP: bytes for clients that ask, JSON for the rest, read back the same either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as pm from "../index.js";
import { PACKMEM_TYPE, fetchTable, respond, send, wantsPackmem } from "../http.js";

const rows = Array.from({ length: 5_000 }, (_, i) => ({
  id: i,
  level: ["info", "warn", "error"][i % 3],
  msg: `request ${i} took ${i % 97} ms`,
  span: i % 4 ? { trace: `t${i % 50}`, tags: ["a", i % 2] } : null,
}));

test("an Accept header asks for packmem only ahead of JSON", () => {
  assert.equal(wantsPackmem(PACKMEM_TYPE), true);
  assert.equal(wantsPackmem(`${PACKMEM_TYPE}, application/json;q=0.9`), true);
  assert.equal(wantsPackmem(`application/json, ${PACKMEM_TYPE};q=0.5`), false);
  assert.equal(wantsPackmem(`${PACKMEM_TYPE};q=0`), false);
  assert.equal(wantsPackmem("*/*"), false);
  assert.equal(wantsPackmem(undefined), false);
  assert.equal(wantsPackmem(new Request("http://x/", { headers: { accept: PACKMEM_TYPE } })), true);
  assert.equal(wantsPackmem({ headers: { accept: PACKMEM_TYPE } }), true);
});

test("respond gives bytes or JSON, and a view sends only its rows", async () => {
  const t = new pm.Table(rows);
  const view = t.where({ level: "error" });
  const asked = await respond(new Request("http://x/", { headers: { accept: PACKMEM_TYPE } }), view);
  assert.equal(asked.headers.get("content-type"), PACKMEM_TYPE);
  assert.equal(asked.headers.get("vary"), "accept");
  const back = pm.Table.fromBytes(new Uint8Array(await asked.arrayBuffer()));
  assert.deepEqual([...back], rows.filter((r) => r.level === "error"));
  const plain = await respond(new Request("http://x/"), t, { status: 201, headers: { "cache-control": "no-store" } });
  assert.equal(plain.status, 201);
  assert.equal(plain.headers.get("content-type"), "application/json");
  assert.equal(plain.headers.get("cache-control"), "no-store");
  assert.deepEqual(await plain.json(), rows);
});

test("fetchTable reads a Node server's bytes, and JSON from a server without packmem", async () => {
  const t = new pm.Table(rows);
  const server = createServer((req, res) => {
    if (req.url === "/plain") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(rows.slice(0, 10)));
    } else if (req.url === "/missing") {
      res.writeHead(404).end();
    } else send(req, res, t.where({ level: "warn" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const got = await fetchTable(pm, `${base}/rows`);
    assert.deepEqual([...got], rows.filter((r) => r.level === "warn"));
    assert.deepEqual([...(await fetchTable(pm, `${base}/plain`))], rows.slice(0, 10));
    const json = await fetch(`${base}/rows`);
    assert.equal(json.headers.get("content-type"), "application/json");
    assert.deepEqual(await json.json(), rows.filter((r) => r.level === "warn"));
    await assert.rejects(fetchTable(pm, `${base}/missing`), /404/);
  } finally {
    server.close();
  }
});

test("bytes are gzipped inside the payload only for clients that read that", async () => {
  const t = new pm.Table(rows);
  const plainBytes = t.toBytes();
  const gzReq = new Request("http://x/", { headers: { accept: `${PACKMEM_TYPE}; enc=gzip, ${PACKMEM_TYPE};q=0.9` } });
  const gz = respond(gzReq, t);
  assert.equal(gz.headers.get("content-type"), `${PACKMEM_TYPE}; enc=gzip`);
  const packed = new Uint8Array(await gz.arrayBuffer());
  assert.ok(packed.byteLength < plainBytes.byteLength / 2, `gzip took ${plainBytes.byteLength} bytes to ${packed.byteLength}`);
  const unzipped = new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  assert.deepEqual(unzipped, new Uint8Array(plainBytes));
  // a 0.3 client does not ask for gzip, so it gets plain bytes it can read
  const old = respond(new Request("http://x/", { headers: { accept: PACKMEM_TYPE } }), t);
  assert.equal(old.headers.get("content-type"), PACKMEM_TYPE);
  assert.equal(respond(gzReq, t, {}, { gzip: false }).headers.get("content-type"), PACKMEM_TYPE);
  const tiny = respond(gzReq, new pm.Table(rows.slice(0, 2)));
  assert.equal(tiny.headers.get("content-type"), PACKMEM_TYPE, "a tiny table is not worth gzipping");
  assert.equal(wantsPackmem(`${PACKMEM_TYPE}; enc=gzip;q=0, application/json`), false);
});

test("fetchTable reads gzipped bytes from respond and send", async () => {
  const t = new pm.Table(rows);
  const types = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/web") {
      const r = respond(new Request("http://x/", { headers: { accept: req.headers.accept } }), t.where({ level: "info" }));
      types.push(r.headers.get("content-type"));
      res.writeHead(200, { "content-type": r.headers.get("content-type") });
      res.end(new Uint8Array(await r.arrayBuffer()));
    } else {
      await send(req, res, t.where({ level: "info" }));
      types.push(res.getHeader("content-type"));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const want = rows.filter((r) => r.level === "info");
    assert.deepEqual([...(await fetchTable(pm, `${base}/web`))], want);
    assert.deepEqual([...(await fetchTable(pm, `${base}/node`))], want);
    assert.deepEqual(types, [`${PACKMEM_TYPE}; enc=gzip`, `${PACKMEM_TYPE}; enc=gzip`]);
  } finally {
    server.close();
  }
});

test("fetchTable asks again for JSON when the server's packmem is newer", async () => {
  const t = new pm.Table(rows.slice(0, 100));
  const newer = Uint8Array.from(t.toBytes());
  newer[4] = 250; // a format this build has not heard of
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.headers.accept);
    if (wantsPackmem(req)) res.writeHead(200, { "content-type": PACKMEM_TYPE }).end(newer);
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows.slice(0, 100)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const got = await fetchTable(pm, `http://127.0.0.1:${server.address().port}/rows`);
    assert.deepEqual([...got], rows.slice(0, 100));
    assert.equal(asked.length, 2);
    assert.equal(asked[1], "application/json");
  } finally {
    server.close();
  }
});
