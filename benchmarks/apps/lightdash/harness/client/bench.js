// The browser side of every arm, loaded from the proxy's origin so Lightdash's session cookie applies.
// The JSON arms port Lightdash's own paging code; the packmem arms use packmem/http's fetchTable on packmem/wasm.
import { fetchTable } from "packmem/http";
import { init } from "packmem/wasm";

// Keep every WebAssembly memory the page creates, to report it apart from the JS heap.
const memories = [];
for (const name of ["instantiate", "instantiateStreaming"]) {
  const original = WebAssembly[name];
  WebAssembly[name] = async function (...args) {
    const result = await original.apply(WebAssembly, args);
    const instance = result instanceof WebAssembly.Instance ? result : result.instance;
    for (const v of Object.values(instance.exports)) if (v instanceof WebAssembly.Memory) memories.push(v);
    return result;
  };
}

// packages/query-sdk/src/apiTransport.ts: PAGE_SIZE = 500. PR #32021: MAX_PARALLEL_RESULT_PAGE_REQUESTS = 8.
const PAGE_SIZE = 500;
const MAX_PARALLEL_RESULT_PAGE_REQUESTS = 8;

let ctx = null;
const pollUrl = (page, size) => `/api/v2/projects/${ctx.project}/query/${ctx.query}?page=${page}&pageSize=${size}`;
const tag = () => ({ "x-bench-arm": ctx.arm, "x-bench-run": ctx.run });

// The SDK's default fetch adapter: res.json(), then `.results`.
async function getPage(page, size) {
  const res = await fetch(pollUrl(page, size), { headers: { accept: "application/json", ...tag() } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for page ${page}`);
  const json = await res.json();
  const r = json.results;
  if (r.status !== "ready") throw new Error(`Unexpected status while paginating results: ${r.status}`);
  return r;
}

// pollQueryRows (apiTransport.ts:949) once the query is ready: page 1, then each nextPage in turn.
async function sequential(size) {
  const firstReadyPage = await getPage(1, size);
  const apiRows = [...firstReadyPage.rows];
  let { nextPage } = firstReadyPage;
  const { totalResults } = firstReadyPage;
  while (nextPage !== undefined && apiRows.length < totalResults) {
    const pageResult = await getPage(nextPage, size);
    apiRows.push(...pageResult.rows);
    nextPage = pageResult.nextPage;
  }
  return apiRows;
}

// PR #32021 (closed, not merged): after page 1, the remaining pages in batches of 8, kept in page order.
async function parallel(size) {
  const firstReadyPage = await getPage(1, size);
  const apiRows = [...firstReadyPage.rows];
  if (firstReadyPage.nextPage !== undefined && apiRows.length < firstReadyPage.totalResults) {
    const totalPages = Math.ceil(firstReadyPage.totalResults / size);
    const firstPageToFetch = firstReadyPage.nextPage;
    const pages = Array.from({ length: totalPages - firstPageToFetch + 1 }, (_, i) => firstPageToFetch + i);
    for (let b = 0; b < pages.length; b += MAX_PARALLEL_RESULT_PAGE_REQUESTS) {
      const batch = pages.slice(b, b + MAX_PARALLEL_RESULT_PAGE_REQUESTS);
      const results = await Promise.all(batch.map((page) => getPage(page, size)));
      for (const r of results) apiRows.push(...r.rows);
    }
  }
  return apiRows;
}

// packmem pages: one fetchTable per page. The row count comes from the readiness check, as the JSON arms'
// totalResults does from their first page.
async function packedPages(pm, size, total) {
  const tables = [];
  for (let page = 1; page <= Math.max(1, Math.ceil(total / size)); page++) {
    tables.push(await fetchTable(pm, pollUrl(page, size), { headers: tag() }));
  }
  return tables;
}

const ARMS = {
  A: { label: "JSON, 500-row pages, one after another (today)", json: true, run: () => sequential(PAGE_SIZE) },
  P: { label: "JSON, 500-row pages, 8 at a time (PR #32021)", json: true, run: () => parallel(PAGE_SIZE) },
  B: { label: "JSON, 2,500-row pages (the page-size cap)", json: true, run: () => sequential(2500) },
  C: { label: "packmem, 2,500-row pages", json: false, run: (pm) => packedPages(pm, 2500, ctx.total) },
  D: { label: "packmem, every row in one response", json: false, run: (pm) => packedPages(pm, ctx.total, ctx.total) },
};

/** Run one arm and keep what it fetched on `globalThis.held`, so a heap reading afterwards counts it. */
async function run({ arm, project, query, total, run }) {
  ctx = { arm, project, query, total, run };
  const a = ARMS[arm];
  const t0 = performance.now();
  let pm = null;
  let initMs = 0;
  if (!a.json) {
    pm = await init(new URL("packmem.wasm", import.meta.url));
    initMs = performance.now() - t0;
  }
  const got = await a.run(pm);
  const ms = performance.now() - t0;
  globalThis.held = got;
  const rows = a.json ? got.length : got.reduce((n, t) => n + t.length, 0);
  const packedBytes = a.json ? 0 : got.reduce((n, t) => n + t.describe().reduce((m, c) => m + c.bytes, 0), 0);
  return { arm, label: a.label, ms, initMs, rows, tables: a.json ? 0 : got.length, packedBytes };
}

/** Bytes of WebAssembly memory the page holds (linear memory only grows, so this is its high-water mark). */
const wasmBytes = () => memories.reduce((n, m) => n + m.buffer.byteLength, 0);

// Correctness: every arm's rows as [field, raw, formatted] in field order, hashed. packmem rows are rebuilt into
// Lightdash's ResultRow shape first ({ field: { value: { raw, formatted } } }), then go through the same path.
function rebuild(flat) {
  const row = {};
  for (const key of Object.keys(flat)) {
    if (!key.endsWith(".raw")) continue;
    const field = key.slice(0, -4);
    row[field] = { value: { raw: flat[key], formatted: flat[`${field}.formatted`] } };
  }
  return row;
}
const canonical = (row) => Object.keys(row).sort().map((f) => [f, row[f].value.raw, row[f].value.formatted]);

async function digest() {
  const json = Array.isArray(globalThis.held) && !(globalThis.held[0]?.describe);
  const rows = json ? globalThis.held : globalThis.held.flatMap((t) => t.toArray().map(rebuild));
  const text = JSON.stringify(rows.map(canonical));
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { rows: rows.length, sha256: hex, first: rows.length ? canonical(rows[0]) : null };
}

const release = () => { globalThis.held = null; };

// Memory method check: allocations whose size is known, to see that a heap reading after GC moves by that much.
//   smis: an array of 10,000,000 small integers, 4 bytes each with pointer compression = 40,000,000 bytes
//   string: a flat one-byte string of 50,000,000 characters = 50,000,000 bytes
//   buffer: a 64 MiB ArrayBuffer, which lives outside the V8 heap (backing storage, not the heap)
//   memory: a WebAssembly.Memory of 1,024 pages = 64 MiB, also outside the heap
function allocate(kind) {
  if (kind === "smis") globalThis.known = new Array(10_000_000).fill(7);
  else if (kind === "string") globalThis.known = new TextDecoder().decode(new Uint8Array(50_000_000).fill(97));
  else if (kind === "buffer") globalThis.known = new Uint8Array(64 * 1024 * 1024).fill(1);
  else if (kind === "memory") {
    globalThis.known = new WebAssembly.Memory({ initial: 1024 });
    new Uint8Array(globalThis.known.buffer).fill(1);
  }
  return true;
}
const free = () => { globalThis.known = null; };

globalThis.bench = { run, digest, release, wasmBytes, allocate, free, arms: Object.fromEntries(Object.entries(ARMS).map(([k, v]) => [k, v.label])) };
