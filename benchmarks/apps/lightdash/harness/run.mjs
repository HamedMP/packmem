// Drives the arms in headless Chromium against the running stack and writes one JSON line per arm.
//
//   node run.mjs --out <file.jsonl> [--arms A,P,B,C,D] [--rounds 1] [--limit 100000] [--memcheck]
//
// Per round: one fresh query execution (invalidateCache), waited on until ready outside any timing, then each arm
// in its own browser process (the order rotates each round). Per arm: page load, a heap reading after GC, the arm
// (timed from its first request to rows in hand), another heap reading after GC, the bytes and requests from the
// DevTools network log, the server's times from the proxy's log, then the correctness digest.
import { createRequire } from "node:module";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";

// Playwright lives in the tools folder outside the repository (setup.sh), not next to this file.
const { chromium } = createRequire(`${process.env.LDB_TOOLS}/`)("playwright");

const { values: opt } = parseArgs({
  options: {
    out: { type: "string" },
    arms: { type: "string", default: "A,P,B,C,D" },
    rounds: { type: "string", default: "1" },
    limit: { type: "string", default: "100000" },
    memcheck: { type: "boolean", default: false },
    maxload: { type: "string", default: "4" },
    waitmin: { type: "string", default: "10" },
  },
});
const BASE = process.env.LDB_URL ?? "http://127.0.0.1:8180";
const NGINX_LOG = `${process.env.LDB_STAGE}/logs/bench.jsonl`;
const PROJECT = "3675b69e-8324-4110-bdca-059031aa8da3"; // SEED_PROJECT in packages/common/src/index.ts
const LOGIN = { email: "demo@lightdash.com", password: "demo_password!" }; // SEED_ORG_1_ADMIN_*
const FLAGS = ["--enable-precise-memory-info", "--js-flags=--expose-gc"];

// A wide, row-level explore of product_events: every event with its user, session, device and product fields.
const F = (n) => `product_events_${n}`;
const QUERY = {
  exploreName: "product_events",
  dimensions: [
    "event_id", "user_id", "session_id", "event_name", "event_timestamp_raw", "event_timestamp_day",
    "device_type", "browser", "referrer", "product_name", "product_category", "product_price", "quantity",
    "cart_total", "page_url", "funnel_stage",
  ].map(F),
  metrics: [F("event_count")],
  filters: {},
  sorts: [{ fieldId: F("event_id"), descending: false }],
  limit: Number(opt.limit),
  tableCalculations: [],
};

const load = () => loadavg().map((x) => x.toFixed(2)).join(" ");
const MAXLOAD = Number(opt.maxload);

/** Wait up to --waitmin minutes for the 1-minute load to reach --maxload, then go ahead either way. */
async function quiet() {
  const t0 = Date.now();
  while (loadavg()[0] > MAXLOAD && Date.now() - t0 < Number(opt.waitmin) * 60_000) await new Promise((s) => setTimeout(s, 15_000));
  return { waited_s: Math.round((Date.now() - t0) / 1000), load: load(), quiet: loadavg()[0] <= MAXLOAD };
}
const out = (rec) => {
  console.log(JSON.stringify(rec));
  if (opt.out) appendFileSync(opt.out, JSON.stringify(rec) + "\n");
};

async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${BASE}${path}`, { method, data, headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${JSON.stringify(body).slice(0, 400)}`);
  return body.results;
}

async function session() {
  const browser = await chromium.launch({ args: FLAGS });
  const ctx = await browser.newContext();
  await api(ctx, "POST", "/api/v1/login", LOGIN);
  const state = await ctx.storageState();
  await browser.close();
  return state;
}

/** Execute the query and wait until its results are stored; returns its uuid and row count. */
async function prepare(state) {
  const browser = await chromium.launch({ args: FLAGS });
  const ctx = await browser.newContext({ storageState: state });
  const t0 = Date.now();
  const { queryUuid } = await api(ctx, "POST", `/api/v2/projects/${PROJECT}/query/metric-query`, {
    query: QUERY,
    invalidateCache: true,
  });
  for (;;) {
    const r = await api(ctx, "GET", `/api/v2/projects/${PROJECT}/query/${queryUuid}?page=1&pageSize=1`);
    if (r.status === "ready") {
      await browser.close();
      return { queryUuid, total: r.totalResults, readyMs: Date.now() - t0, columns: Object.keys(r.columns ?? {}) };
    }
    if (["error", "expired", "cancelled"].includes(r.status)) throw new Error(`query ${r.status}: ${r.error}`);
    await new Promise((s) => setTimeout(s, 250));
  }
}

async function heap(cdp) {
  for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
  await new Promise((s) => setTimeout(s, 500));
  await cdp.send("HeapProfiler.collectGarbage");
  return cdp.send("Runtime.getHeapUsage");
}

async function openPage(state) {
  const browser = await chromium.launch({ args: FLAGS });
  const ctx = await browser.newContext({ storageState: state });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await page.goto(`${BASE}/bench/index.html`);
  await page.waitForFunction(() => globalThis.bench);
  return { browser, page, cdp, errors };
}

function serverTimes(run, arm) {
  if (!existsSync(NGINX_LOG)) return null;
  const lines = readFileSync(NGINX_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const mine = lines.filter((l) => l.run === run && l.arm === arm);
  const up = mine.map((l) => Number(l.upstream_time) || 0);
  return {
    requests: mine.length,
    upstream_s_sum: +up.reduce((a, b) => a + b, 0).toFixed(3),
    upstream_s_max: +Math.max(0, ...up).toFixed(3),
    proxy_bytes_sent: mine.reduce((a, l) => a + l.bytes_sent, 0),
    types: [...new Set(mine.map((l) => `${l.type}${l.enc ? ` +${l.enc}` : ""}`))],
    statuses: [...new Set(mine.map((l) => l.status))],
  };
}

async function runArm(state, q, arm, run) {
  const loadStart = load();
  const { browser, page, cdp, errors } = await openPage(state);
  await cdp.send("Network.enable");
  const net = new Map();
  cdp.on("Network.responseReceived", (e) => {
    if (e.response.url.includes("/api/v2/")) net.set(e.requestId, { encoding: e.response.headers["content-encoding"] ?? "", type: e.response.mimeType });
  });
  cdp.on("Network.loadingFinished", (e) => {
    if (net.has(e.requestId)) net.get(e.requestId).bytes = e.encodedDataLength;
  });
  const before = await heap(cdp);
  const r = await page.evaluate((a) => globalThis.bench.run(a), { arm, project: PROJECT, query: q.queryUuid, total: q.total, run });
  const after = await heap(cdp);
  const wasm = await page.evaluate(() => globalThis.bench.wasmBytes());
  const d = await page.evaluate(() => globalThis.bench.digest());
  await browser.close();
  const reqs = [...net.values()];
  return {
    kind: "arm", run, arm, label: r.label, query_rows: q.total, rows: r.rows, digest_rows: d.rows, sha256: d.sha256,
    ms: +r.ms.toFixed(1), wasm_init_ms: +r.initMs.toFixed(1), tables: r.tables, packed_bytes: r.packedBytes,
    wire_bytes: reqs.reduce((a, x) => a + (x.bytes ?? 0), 0), requests: reqs.length,
    encodings: [...new Set(reqs.map((x) => `${x.type}${x.encoding ? ` +${x.encoding}` : ""}`))],
    heap_used_before: before.usedSize, heap_used_after: after.usedSize, heap_held: after.usedSize - before.usedSize,
    backing_before: before.backingStorageSize, backing_after: after.backingStorageSize,
    // Held = heap plus memory outside it (ArrayBuffers, WebAssembly memory, external strings); see --memcheck.
    held_total: after.usedSize - before.usedSize + (after.backingStorageSize - before.backingStorageSize),
    wasm_memory_bytes: wasm, server: serverTimes(run, arm), errors, first_row: d.first,
    load_start: loadStart, load_end: load(), noisy: Number(loadStart.split(" ")[0]) > MAXLOAD,
  };
}

async function memcheck(state) {
  const { browser, page, cdp } = await openPage(state);
  for (const kind of ["string", "smis", "buffer", "memory"]) {
    const a = await heap(cdp);
    await page.evaluate((k) => globalThis.bench.allocate(k), kind);
    const b = await heap(cdp);
    await page.evaluate(() => globalThis.bench.free());
    const c = await heap(cdp);
    out({ kind: "memcheck", alloc: kind, heap_delta: b.usedSize - a.usedSize, heap_after_free_delta: c.usedSize - a.usedSize,
      backing_delta: b.backingStorageSize - a.backingStorageSize, backing_after_free_delta: c.backingStorageSize - a.backingStorageSize });
  }
  await browser.close();
}

const state = await session();
if (opt.memcheck) await memcheck(state);
const arms = opt.arms.split(",");
let failed = false;
for (let round = 0; round < Number(opt.rounds); round++) {
  const wait = await quiet();
  const q = await prepare(state);
  const run = `${new Date().toISOString()}-r${round}`;
  out({ kind: "query", run, ...q, limit: QUERY.limit, load: load(), wait });
  const order = arms.map((_, i) => arms[(i + round) % arms.length]);
  const results = [];
  for (const arm of order) {
    const rec = await runArm(state, q, arm, run);
    out(rec);
    results.push(rec);
  }
  const hashes = new Set(results.map((r) => r.sha256));
  const ok = hashes.size === 1 && results.every((r) => r.rows === q.total && r.digest_rows === q.total && !r.errors.length);
  out({ kind: "check", run, ok, sha256: [...hashes], rows: results.map((r) => [r.arm, r.rows]) });
  if (!ok) failed = true;
}
if (failed) {
  console.error("CORRECTNESS FAILED: arms disagree or lost rows; see the check lines");
  process.exit(1);
}
