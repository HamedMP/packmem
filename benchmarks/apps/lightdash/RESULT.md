# Lightdash query results: JSON pages vs packmem bytes

**Headline (measured, 100,000 rows, 5 rounds, 1-minute load 1.2 to 2.1).** The fair comparison is packmem against
B, JSON at Lightdash's 2,500-row page cap, gzipped by the proxy.

- **Every row in one packmem response (D)** against B: usable in 11.8 s against 13.7 s (1.16x faster), 3.25 MB against
  4.09 MB over the wire (1.26x less), and 15.5 MB held in the browser against 115.3 MB (7.4x less).
- **packmem at the same 2,500-row pages (C)** against B: no faster (13.5 s against 13.7 s, inside the runs' spread),
  1.2 s more server time for packing, 3.27 MB over the wire (1.25x less), and 18.7 MB held (6.2x less).

**Where packmem wins:** memory in the browser, by a lot, and bytes, by a quarter. **Where it doesn't:** time is mostly
Lightdash's server reading and formatting the rows, about 12 s of B's 13.7 s, and packmem does not touch that. C
costs slightly more server time than B. D's time gain comes from a single response, which needs a server limit raised
(below). Gzipped JSON is already 35x smaller than plain JSON on these rows, so the byte saving over gzip is modest. Stock
Lightdash sends plain JSON when no proxy compresses it, and against that packmem is 20x smaller uncompressed and 41x
smaller as `fetchTable` receives it (gzipped inside the payload, which needs no proxy).

The question: a Lightdash data app or chart that loads a large query (lightdash#31919: about 91,000 rows took
about 2 min 13 s, of which the warehouse took about 15 s) spends its time fetching 500-row JSON pages one after
another. What do packmem bytes from the same endpoint change, against the cheap fixes that need no packmem: bigger
pages, gzip, and parallel requests (lightdash#32021, closed without merging)?

## What runs

- Lightdash 3.261.1 (commit `7d257bd93b7f312c5a63732c82956d870546da4a`), the published image pinned by digest, as
  `examples/full-jaffle-shop-demo` runs it: Postgres as both Lightdash's database and the warehouse, the demo's dbt
  project and seed, plus MinIO for stored results (from the repository's root `docker-compose.yml`) and nginx in front.
  `harness/docker-compose.yml` lists every setting and why it differs from the demo's.
- One table scaled: `raw_product_events` from 36,827 to 100,000 rows by `harness/seed.py` (deterministic: copies with
  new ids, users, sessions and later timestamps).
- The query: the `product_events` explore, 16 dimensions (ids, user, session, event, raw and day timestamps, device,
  browser, referrer, product fields, page URL, funnel stage) and one metric (`event_count`), sorted by `event_id`,
  limit 100,000. Each row has 17 fields, each `{ value: { raw, formatted } }`.

## The patch

`harness/QueryController.packmem.patch`, 25 lines added to `packages/backend/src/controllers/v2/QueryController.ts`
(MIT; nothing under `packages/backend/src/ee`). When a ready page is requested with `Accept: application/vnd.packmem`,
the v2 results endpoint (`GET /api/v2/projects/{projectUuid}/query/{queryUuid}?page&pageSize`) sends that page as
packmem bytes with `send` from `packmem/http`, each cell flattened into `<field>.raw` and `<field>.formatted` columns.
Any other request gets Lightdash's JSON, unchanged. packmem 0.3.2 from npm.

The image ships compiled JavaScript, so `setup.sh` transpiles the patched file with TypeScript's `transpileModule` and
the backend's compiler options and puts it over the image's copy. It first transpiles the unpatched file and checks it
matches the image's `dist/controllers/v2/QueryController.js` (ignoring comments, formatting and Sentry's debug id);
setup stops if it does not.

## Arms

All arms fetch the same stored results (one query execution per round, waited on until ready before any timing) in
headless Chromium, each in its own browser process. The JSON arms port Lightdash's own client code.

| Arm | What | Source |
| --- | --- | --- |
| A | JSON, 500-row pages, one after another | `pollQueryRows`, `packages/query-sdk/src/apiTransport.ts:949` (`PAGE_SIZE = 500`) |
| P | JSON, 500-row pages, 8 requests at a time | lightdash#32021 (`MAX_PARALLEL_RESULT_PAGE_REQUESTS = 8`) |
| B | JSON, 2,500-row pages, one after another | A at `LIGHTDASH_QUERY_MAX_PAGE_SIZE`'s default, 2,500 |
| C | packmem, 2,500-row pages, one after another | `fetchTable` per page on `packmem/wasm` |
| D | packmem, every row in one response | `fetchTable` once, `pageSize` = row count |

Compression: Lightdash's server does not compress API responses (it only serves pre-gzipped frontend files), so the
nginx proxy gzips `application/json` at level 6. packmem bytes are not in the proxy's `gzip_types`; `packmem/http`
gzips them inside the payload (`application/vnd.packmem; enc=gzip`) because `fetchTable` asks for that.

Server limits changed: `LIGHTDASH_QUERY_MAX_LIMIT=100000` (self-hosted default 5,000 rows per query) and
`LIGHTDASH_QUERY_MAX_PAGE_SIZE=100000` (default 2,500; raised only so D can ask for one page; A, P, B and C ask for
500 or 2,500).

## Measured per arm

- Bytes over the wire: the sum of DevTools `encodedDataLength` for the arm's `/api/v2/` responses, and the proxy's
  `bytes_sent`.
- Server time: nginx's `upstream_response_time` per request (Lightdash reading the page from storage, formatting it,
  and for C and D packing it), summed and max.
- Until usable: from the arm's first request to rows in hand: an array of Lightdash row objects for A, P and B, opened
  packmem tables for C and D (including `packmem/wasm`'s start-up, also reported alone). Rows are not rebuilt as
  objects in this window.
- Memory held: `Runtime.getHeapUsage` after forced GC (`HeapProfiler.collectGarbage`), after the arm minus before it,
  with the fetched rows still referenced. Two parts: `usedSize` (the V8 heap) and `backingStorageSize` (memory outside
  the heap: ArrayBuffers, WebAssembly memory, external strings). Held = both. WebAssembly memory is also reported on
  its own (`memory.buffer.byteLength` of every instance; linear memory only grows, so this is its high-water mark).
- Correctness: every arm's rows as `[field, raw, formatted]` in field order, SHA-256. packmem rows are rebuilt into
  Lightdash's `{ field: { value: { raw, formatted } } }` shape first. All arms must give the same hash and the
  query's row count; `run.mjs` exits non-zero otherwise.
- Memory method check (`--memcheck`, before the arms): known allocations, read the same way, then freed and read again.
  In the smoke run every reading moved by the allocation's size, in the part expected, and came back after freeing:

  | Allocation | Expected | `usedSize` moved | `backingStorageSize` moved | After freeing |
  | --- | --- | ---: | ---: | --- |
  | 10,000,000 small integers in an array | 40,000,000 B in the heap | 40,000,024 | 0 | back to +0 |
  | 50,000,000-character string from `TextDecoder` | 50,000,000 B | 5,236 | 50,000,005 | +5 backing |
  | 64 MiB `Uint8Array` | 67,108,864 B outside the heap | 7,412 | 67,108,864 | back to +0 backing |
  | 64 MiB `WebAssembly.Memory` | 67,108,864 B outside the heap | 384 | 67,108,864 | back to +0 backing |

  The string came out as an external string, counted outside the heap, which is why held memory counts both parts.
  An earlier headless check on this repository's log viewer read `performance.memory` without forced GC and gave
  readings that disagreed; that is not used here.

## Results: 100,000 rows

`harness/run.sh 5` on 2026-11-15, 17:06 to 17:16 UTC: a fresh stack, one warm-up round with the memory check
(`results/100k/warmup.jsonl`, not in the tables), then 5 rounds with the arm order rotating. Every round started at a
1-minute load of 4 or less, and no arm started above it, so no run is marked noisy. All 25 arm runs (and the warm-up's
5) returned 100,000 rows with the same SHA-256, `b95aabd9…07c92dea`. The query took about 0.83 s to be ready in each
round; that is outside every arm's time.

Median (min-max) of 5 runs per arm:

| Arm | Until usable, s | Over the wire, MB | Requests | Server time, s (sum) | Held in the browser, MB | of which JS heap | of which WebAssembly |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **B: JSON, 2,500-row pages, gzipped by the proxy** | **13.73** (13.64-17.38) | **4.09** | 40 | 12.18 (12.11-15.77) | **115.25** | 115.25 | 0 |
| **C: packmem, 2,500-row pages** | **13.46** (13.36-16.30) | **3.27** | 40 | 13.39 (13.30-16.23) | **18.69** | 0.21 | 18.48 |
| **D: packmem, every row in one response** | **11.85** (11.77-11.98) | **3.25** | 1 | 11.82 (11.74-11.95) | **15.52** | 0.18 | 15.34 |
| A: JSON, 500-row pages, one after another (Lightdash's SDK today) | 20.57 (20.42-23.13) | 4.93 | 200 | 18.53 (18.38-21.12) | 115.18 | 115.18 | 0 |
| P: JSON, 500-row pages, 8 at a time (lightdash#32021) | 19.98 (18.08-20.49) | 4.93 | 200 | 91.25 (83.31-94.18) | 115.19 | 115.19 | 0 |

- Over the wire: DevTools' `encodedDataLength` for the arm's `/api/v2/` responses (bodies plus headers), the same in
  every run. Held: heap plus memory outside it after forced GC, with the rows still referenced; also the same in every
  run. packmem's held memory is almost all WebAssembly linear memory (its high-water mark: decompression buffers and
  the tables).
- Server time is the sum of nginx's `upstream_response_time` over the arm's requests. For the sequential arms it is
  most of the time until usable. What remains (median time minus median server time) is network, the browser's
  decoding and parsing, and request overhead: about 1.5 s for B, 2.0 s for A, 0.07 s for C and 0.03 s for D. For D, the server streams its one response while the
  browser decompresses it, so the two overlap.
- P is not faster than A here: Lightdash is capped at 4 CPUs, and 8 parallel requests make each one slower (91 s of
  server time in total against 18.5 s). On a server with more cores the result would differ. It is not tested here.
- "Until usable" means rows in hand in the form the next step reads: Lightdash's row objects for A, P and B, opened
  packmem tables for C and D. Code that needs every row as a Lightdash row object would pay to rebuild them from the
  tables. That cost is not in these times. The correctness digest does that rebuild, untimed.
- A and P are Lightdash's current behaviour and the proposed fix, for context only. The comparison is C and D
  against B.

What compresses what, measured with curl on one stored query after the runs (`results/100k/sizes.txt`), page 1:

| pageSize | JSON | JSON, gzipped by the proxy | packmem | packmem, gzipped inside the payload |
| ---: | ---: | ---: | ---: | ---: |
| 500 | 671,079 B | 20,630 B | 51,615 B | 16,197 B |
| 2,500 | 3,344,174 B | 98,059 B | 250,055 B | 76,200 B |
| 100,000 | 134,506,783 B | 3,874,874 B | 6,606,607 B | 3,246,870 B |

- JSON: Lightdash sends it uncompressed; the nginx proxy gzips `application/json` at level 6 when the client sends
  `Accept-Encoding: gzip`. Browsers always do.
- packmem: `packmem/http` gzips the bytes itself, inside the payload, and labels them
  `application/vnd.packmem; enc=gzip`, because `fetchTable` asks for that. The proxy does not compress
  `application/vnd.packmem`. `fetchTable` decompresses with the browser's `DecompressionStream`.
- The data repeats the demo's 36,827 events three times with new ids, users, sessions and timestamps (`seed.py`).
  The copies are further apart than gzip's 32 KB window, so gzip cannot exploit them. packmem's column dictionaries
  see the repeated values (event names, browsers, products) either way.

Load for every arm run (1, 5 and 15 minutes), and the server's start and end: `results/100k/runs.jsonl` (`load_start`,
`load_end`) and `results/100k/load.txt` (start 1.26, end 1.14). The 1-minute load at an arm's start ranged from 1.18
to 2.09. The server also runs matrix-os CI; the low load suggests it was quiet in this window, but that was not
checked directly.

Raw files: `results/100k/runs.jsonl` (one line per round and arm), `warmup.jsonl` (with the memory check),
`proxy.jsonl.gz` (nginx's per-request log), `sizes.txt`, `seed.txt` and `lightdash.log.gz` (the Lightdash container's
log, including dbt's seed run). Tables: `python3 harness/summarize.py results/100k/runs.jsonl`.

## Setup notes

- The demo's compose file is not enough for the published image at 3.261.1: the demo seed needs `DBT_DEMO_DIR`
  (set to `/usr/app`), and results need S3 storage (MinIO). The demo entrypoint rolls back every migration first,
  which fails on an already-migrated database (`20260916120000_disable_ai_agent_memory_for_all_organizations` is
  irreversible), so each start uses a fresh database (`docker compose down -v`).
- Lightdash is capped at 4 CPUs and 16 GB, Postgres, MinIO and nginx at 2 CPUs each. The server also runs CI; the
  load average is recorded per arm.

## Smoke test (correctness only, not timed)

`harness/smoke.sh`: the same query with limit 6,000 (12 pages of 500, 3 of 2,500, one of 6,000), one round, all five
arms, under `nice -n 19` while another benchmark was running. Run twice: once on a stack built step by step, once
after `setup.sh` rebuilt everything from nothing (`results/smoke/smoke-6000.jsonl`, `smoke-6000-fresh-setup.jsonl`);
versions: `results/smoke/versions.txt`. Both gave the same hash.

- All five arms returned 6,000 rows with the same SHA-256 (`df7f2b63…75f8a8`), the packmem rows rebuilt into
  Lightdash's row shape. No page errors.
- Each row has 17 fields; `raw` holds numbers, strings and nulls (for example `cart_total` is null with `formatted`
  "∅" on page views), and `event_count` arrives as the string "1" (Postgres bigint).
- The JSON arms' responses went out gzipped by the proxy (`application/json; charset=utf-8`, gzip), the packmem arms'
  as `application/vnd.packmem; enc=gzip`, not touched by the proxy.

The smoke timings and sizes are not results (6,000 rows, a busy machine, niced client).
