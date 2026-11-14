// A table shared with worker threads: one copy, read-only while shared, the same answers in every thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { Table } from "../index.js";

const INDEX = new URL("../index.js", import.meta.url).href;
const rows = Array.from({ length: 30_000 }, (_, i) => {
  const r = { id: i, k: ["b", "a", "c"][i % 3], v: ((i * 7919) % 1000) / 8, s: `r${i % 50}` };
  if (i % 5 === 0) r.note = i % 10 === 0 ? null : { n: i, tags: ["a", 1.5] };
  return r;
});

/** Everything a reader can ask of a table, as plain data. */
const READS = `(t) => {
  let lazy = 0;
  for (const r of t.lazy()) lazy += typeof r.v === "number" ? r.v : 0;
  return {
    n: t.length,
    names: t.names,
    json: new TextDecoder().decode(t.jsonBuffer()),
    at: t.at(-1),
    count: t.count({ k: "a", v: { gte: 10, lt: 100 } }),
    view: t.where({ s: { prefix: "r1" } }).rows({ offset: 3, limit: 7 }),
    sum: t.sum("v", { k: "c" }),
    groups: { ...t.groupCount("s", { k: "b" }) },
    column: t.column("note", { id: { lt: 30 } }),
    lazy,
  };
}`;
// READS is a constant in this file, kept as source so the workers run exactly the same function
const reads = eval(READS);

/** A worker that attaches to `handle`, answers `msg` commands, and stays alive until told to stop. */
function reader(handle) {
  const w = new Worker(
    `
    import { workerData, parentPort } from "node:worker_threads";
    import { Table } from ${JSON.stringify(INDEX)};
    const reads = ${READS};
    const t = Table.fromShared(workerData);
    const tryWrite = (f) => { try { f(); return null; } catch (e) { return e.message; } };
    parentPort.on("message", (cmd) => {
      if (cmd === "reads") parentPort.postMessage(reads(t));
      else if (cmd === "writes")
        parentPort.postMessage({
          shared: t.shared,
          push: tryWrite(() => t.push({ id: -1 })),
          set: tryWrite(() => t.set(0, { id: -1 })),
          lazy: tryWrite(() => { for (const r of t.lazy()) { r.id = -1; break; } }),
          sort: tryWrite(() => t.sort({ key: "v" })),
        });
      else if (cmd === "head") parentPort.postMessage({ n: t.length, first: t.at(0) });
      else if (cmd === "stop") parentPort.close();
    });
    parentPort.postMessage("ready");
    `,
    { eval: true, workerData: handle },
  );
  const next = () => new Promise((resolve, reject) => (w.once("message", resolve), w.once("error", reject)));
  const ask = (cmd) => {
    const p = next();
    w.postMessage(cmd);
    return p;
  };
  return { ready: next(), ask, stop: () => w.terminate() };
}

test("two workers read the shared table exactly as the owner does", async () => {
  const t = new Table(rows);
  const h = t.share();
  assert.deepEqual(Object.keys(h).sort(), ["columns", "packmemShared", "pid", "rows"]);
  assert.equal(h.rows, rows.length);
  const mine = reads(t);
  const [a, b] = [reader(h), reader(h)];
  try {
    await Promise.all([a.ready, b.ready]);
    const [ra, rb] = await Promise.all([a.ask("reads"), b.ask("reads")]);
    for (const k of Object.keys(mine)) {
      assert.deepEqual(ra[k], mine[k], k);
      assert.deepEqual(rb[k], mine[k], k);
    }
    assert.equal(mine.json, JSON.stringify(rows));
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
});

test("a shared table refuses changes, in the owner and in a worker", async () => {
  const t = new Table(rows.slice(0, 100));
  const h = t.share();
  assert.equal(t.shared, true);
  assert.equal(t.share().packmemShared, h.packmemShared, "sharing again gives the same handle");
  const ro = /shared and read-only/;
  assert.throws(() => t.push({ id: -1 }), ro);
  assert.throws(() => t.set(0, { id: -1 }), ro);
  assert.throws(() => t.update(0, { id: -1 }), ro);
  assert.throws(() => t.splice(0, 1), ro);
  assert.throws(() => t.sort({ key: "v" }), ro);
  assert.throws(() => t.clear(), ro);
  assert.throws(() => {
    for (const r of t.lazy()) {
      r.id = -1;
      break;
    }
  }, ro);
  assert.equal(t.length, 100, "a refused append leaves the table as it was");
  assert.deepEqual(t.slice(), rows.slice(0, 100));
  const copy = t.copy();
  assert.equal(copy.shared, false, "copy() is private and writable");
  copy.push({ id: -1 });
  assert.equal(copy.length, 101);

  const w = reader(h);
  try {
    await w.ready;
    const r = await w.ask("writes");
    assert.equal(r.shared, true);
    for (const k of ["push", "set", "lazy", "sort"]) assert.match(r[k], ro, k);
  } finally {
    await w.stop();
  }
});

test("unshare with no readers makes the table writable again", () => {
  const t = new Table(rows.slice(0, 1000));
  t.share();
  t.unshare();
  assert.equal(t.shared, false);
  assert.deepEqual(t.slice(), rows.slice(0, 1000));
  t.push({ id: -1 });
  t.set(0, { id: -2 });
  assert.equal(t.length, 1001);
  assert.deepEqual(t.at(0), { id: -2 });
  t.unshare();
  assert.equal(t.length, 1001, "unsharing a table that is not shared does nothing");
});

test("unshare while a worker still reads gives the owner a private copy", async () => {
  const t = new Table(rows.slice(0, 1000));
  const h = t.share();
  const w = reader(h);
  try {
    await w.ready;
    t.unshare();
    t.set(0, { id: -2 });
    t.push({ id: -1 });
    assert.equal(t.length, 1001);
    assert.deepEqual(t.at(0), { id: -2 });
    const seen = await w.ask("head");
    assert.equal(seen.n, 1000, "the worker keeps the table it attached to");
    assert.deepEqual(seen.first, rows[0]);
    assert.throws(() => Table.fromShared(h), /no longer exists/, "new readers cannot attach after unshare");
  } finally {
    await w.stop();
  }
});

test("a handle from another process, or not a handle at all, is refused", () => {
  const t = new Table(rows.slice(0, 10));
  const h = t.share();
  assert.throws(() => Table.fromShared({ ...h, pid: h.pid + 1 }), /worker threads, not processes/);
  assert.throws(() => Table.fromShared({}), TypeError);
  assert.throws(() => Table.fromShared(null), TypeError);
  assert.throws(() => Table.fromShared({ ...h, packmemShared: "x" }), /not a packmem shared-table handle/);
  assert.throws(() => Table.fromShared({ ...h, packmemShared: "999999" }), /no longer exists/);
});

test("a table whose owner was garbage-collected cannot be attached", () => {
  // garbage collection is only exposed with --expose-gc, so this runs in a child process
  const code = `
    import { Table } from ${JSON.stringify(INDEX)};
    const make = () => new Table(Array.from({ length: 1000 }, (_, i) => ({ i }))).share();
    const h = make();
    for (let round = 0; round < 20; round++) {
      globalThis.gc();
      await new Promise((r) => setImmediate(r));
      try { Table.fromShared(h); } catch (e) { console.log(e.message); process.exit(0); }
    }
    console.log("still attachable");
  `;
  const out = execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", code], { encoding: "utf8" });
  assert.match(out, /no longer exists/);
});

const wasmFile = new URL("../wasm-dist/packmem_bg.wasm", import.meta.url);
test("the WebAssembly build says sharing is not available", { skip: !existsSync(wasmFile) && "build wasm first" }, async () => {
  const { init } = await import("../wasm.js");
  const wasm = await init(readFileSync(wasmFile));
  const t = new wasm.Table(rows.slice(0, 10));
  assert.throws(() => t.share(), /not available in the WebAssembly build/);
  assert.throws(() => wasm.Table.fromShared({ packmemShared: "1", pid: 1 }), /not available in the WebAssembly build/);
  assert.equal(t.shared, false);
});
