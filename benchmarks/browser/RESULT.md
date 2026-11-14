# JSON or packmem bytes in the browser

Measured 2026-11-14 with **packmem 0.3.0 from npm** (Node addon on the server, `packmem/wasm` in the page) and
headless Chromium 159. Every number below is a median from `results/runs.jsonl`; the tables are
`results/tables.md`, made from it by `summarize.mjs`.

## Method

- **Machine:** Linux 6.8, AMD Ryzen 9 7950X3D (32 threads), 124 GB, Node v24.22.0 (`results/machine.txt`).
  The server is shared. Its load average was 4.7 to 6.5 while flights ran, 25 to 41 for chat, issues (up to 1,000
  rows), traces and logs, and 1.0 to 1.5 for issues at 3,000 rows (`results/load.jsonl`), so timings for the busy
  datasets carry more noise. JSON and packmem runs alternate, so both sides saw the same load. Each dataset ran
  serially under `systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10`.
- **Data:** the five sets of `../wire-size` (`prep.py`), at 10, 100, 1,000, 10,000 and 100,000 rows (issues: 3,000
  at most):
  - `flights`: nycflights13.
  - `chat`: LLaVA-v1.5 mix665k conversations (lists of `{from, value}` turns, long text).
  - `issues`: public facebook/react issues as the GitHub API returns them (nested user, labels, reactions; long text).
  - `traces`: synthetic OpenTelemetry-style spans with a nested attributes record.
  - `logs`: synthetic service logs with UUIDs and templated messages.
- **Payloads** (`bench.mjs`): the first N records as one compact JSON array, and as packmem bytes
  (`parse(lines).toBytes()` in Node). Each is served as is and Brotli-compressed at quality 5 (a usual setting for
  responses compressed on the fly) with `content-encoding: br`, so the browser decompresses it.
- **Runs:** 7 per cell, each in a fresh browser context and page (nothing cached, the WebAssembly module instantiated
  again), alternating JSON and packmem. Brotli payloads also run with the network throttled to 20 Mbit/s and 20 ms
  latency (Chrome DevTools Protocol network emulation).
- **What the page measures** (`page.js`):
  - **Time until usable:** JSON is `fetch` + `JSON.parse`. packmem is `fetch` + `Table.fromBytes`. The
    WebAssembly start-up (fetching and instantiating `packmem_bg.wasm`) happens before the clock starts and is listed
    separately: a page pays it once, not per table.
  - **First 50 rows** as objects, **one filter and count** (`Array.filter` on the objects; `count()` on the table:
    carrier = UA, image contains "coco", state = open, status = ERROR, level = ERROR), and for packmem **every row as
    an object**.
  - **Memory held by the data:** after a full garbage collection, the JS heap plus ArrayBuffer backing stores (CDP
    `Runtime.getHeapUsage`) plus the WebAssembly memory, with the data held, minus the same just before the fetch.
- **0.3.0 and record columns:** issues (user, reactions) and traces (attributes) hold a single record per row in some
  columns. 0.3.0 stores a 4-byte offset per row for those, which the next release drops (main 05af6fa, format 5), so
  their packmem sizes here are 4 bytes a row larger than the next release will write. `../wire-size/RESULT.md` has
  the sizes from that build.

## Findings

### 1. Size: much smaller uncompressed; after Brotli, smaller for structured data from 100 rows, not for long text

| dataset | 10 rows | 100 | 1,000 | 10,000 | 100,000 |
| --- | ---: | ---: | ---: | ---: | ---: |
| flights | +11% | −21% | −27% | −37% | −38% |
| traces | +17% | −11% | −27% | −8% | −17% |
| logs | +19% | +10% | −4% | −12% | −16% |
| chat | +9% | +8% | +2% | −1% | +7% |
| issues | +10% | +6% | +3% | +1% (3,000 rows) | |

packmem bytes against the JSON array, both Brotli 5. Uncompressed, packmem is 18% to 92% smaller in every cell.

### 2. Time until usable: packmem is ahead from about 1,000 rows, and 2.6 to 7.6 times faster at 10,000 rows and up

Uncompressed, loopback (the network costs nothing, so this is the browser's own work):

| dataset | 100 rows | 1,000 | 10,000 | 100,000 |
| --- | ---: | ---: | ---: | ---: |
| flights | 1.13 vs 1.66 ms | 2.86 vs 2.02 | 15.8 vs 2.94 | 93.3 vs 12.2 (7.6x) |
| chat | 2.88 vs 2.72 | 24.0 vs 6.59 | 242 vs 63.6 | 730 vs 130 (5.6x) |
| issues | 8.08 vs 5.77 | 64.4 vs 17.5 | 126 vs 26.4 at 3,000 rows (4.8x) | |
| traces | 2.06 vs 3.62 | 4.56 vs 4.43 | 27.9 vs 7.95 | 184 vs 35.0 (5.3x) |
| logs | 2.41 vs 4.36 | 6.01 vs 5.44 | 17.1 vs 6.67 | 105 vs 29.6 (3.6x) |

JSON first, then packmem. With Brotli on loopback the 100,000-row gains are 2.2x to 4.2x, because both sides now
wait on decompression. At 20 Mbit/s the download dominates and packmem is 1.05x to 1.68x faster at 10,000 rows and
up, about level below.

### 3. Memory: 1.3 to 2.4 times less from 10,000 rows

| dataset | 10,000 rows, JSON vs packmem | 100,000 rows |
| --- | ---: | ---: |
| flights | 1.3 vs 0.7 MB | 12.6 vs 5.3 MB |
| chat | 21.7 vs 16.8 MB | 140.6 vs 72.5 MB |
| traces | 2.2 vs 1.1 MB | 22.2 vs 9.9 MB |
| logs | 2.0 vs 1.1 MB | 19.7 vs 11.2 MB |

Issues: 6.0 MB for both at 1,000 rows; 18.4 vs 14.0 MB at 3,000 rows.

### 4. Where packmem loses

- **Small responses.** Below about 1,000 rows packmem is slower to open (1 to 2.5 ms of fixed cost against well
  under 1 ms for `JSON.parse`), larger after Brotli, and holds more memory (0.09 to 0.7 MB at 10 rows, mostly the
  WebAssembly memory it grows into). Keep JSON for those; `packmem/http` sends JSON to clients that don't ask for bytes.
- **WebAssembly start-up:** 6 to 17 ms per page (median per cell), on top of the times above, once per page.
- **Every row as an object:** building all rows from the table takes 2 to 3 times as long as `JSON.parse` of the same
  rows (flights 100,000: 150 vs 52 ms; chat: 1,120 vs 579 ms). packmem pays off when a page shows a window of rows
  (`useRows`) or asks the table questions (`count`, `where`, `groupCount`), not when it turns everything into objects.
- **Long text after Brotli:** chat and issues are level with Brotli JSON to 10% larger at every size; their time
  and memory still improve from 1,000 rows.
- **Per-call overhead:** reading 50 rows or running one filter costs about 1 to 2 ms on the table, where the JSON
  objects answer in microseconds below 10,000 rows. At 100,000 rows the filter is faster on the table for chat,
  traces and logs, and level for flights.

## Separately: packmem/http gzip on main 90602dc

packmem/http on main 90602dc (after 0.3.0) gzips the bytes inside the payload and labels them
`application/vnd.packmem; enc=gzip`, because hosts such as Next.js compress only the types they know; `fetchTable`
unzips them with `DecompressionStream`. This pass reproduces that: the 0.3.0 bytes gzipped at zlib's default level
(not below 1,024 bytes, as that code does), unzipped in the page, against JSON sent with `content-encoding: gzip` at
the same level, as Next.js sends JSON. The byte format is unchanged on main; only the HTTP layer is newer, so these
rows are kept apart from the 0.3.0 tables. Raw runs: `results/runs-gzip-main-90602dc.jsonl`; tables:
`results/tables-gzip-main-90602dc.md`. The server was quiet for this pass (load average 0.3 to 1.5,
`results/load-gzip-main-90602dc.jsonl`), so its times are not comparable with the busier 0.3.0 pass.

| dataset | rows | bytes sent vs gzip JSON | time until usable, loopback (JSON vs packmem, ms) | at 20 Mbit/s |
| --- | ---: | ---: | ---: | ---: |
| flights | 10 | +52% (947 bytes, not gzipped) | 1.16 vs 1.88 | 0.96x |
| flights | 1,000 | −31% | 2.76 vs 2.08 (1.33x) | 1.16x |
| flights | 100,000 | −52% | 89.2 vs 16.2 (5.5x) | 2.13x |
| chat | 1,000 | +2% | 17.4 vs 7.34 (2.4x) | 1.05x |
| chat | 100,000 | +4% | 514 vs 201 (2.6x) | 1.01x |
| issues | 3,000 | −9% | 132 vs 30.7 (4.3x) | 1.26x |
| traces | 100,000 | −2% | 108 vs 31.0 (3.5x) | 1.07x |
| logs | 100,000 | −7% | 70.4 vs 34.8 (2.0x) | 1.09x |

- **Against gzip JSON the bytes do better than against Brotli JSON:** flights is 29% to 52% smaller from 100 rows,
  issues 7% to 9% smaller from 1,000 rows, logs 6% to 7% smaller from 10,000 rows. Chat stays level to 5% larger
  from 100 rows (12% at 10).
- **Unzipping in the page costs little:** packmem's "body" time includes `DecompressionStream`, and the bytes are
  still usable 2.0 to 5.5 times sooner than gzip JSON at 10,000 rows and up on loopback.
- **Still slower or larger below about 1,000 rows,** as in the 0.3.0 pass: 0.56x to 0.94x of JSON's speed at 10 and
  100 rows (issues at 100 rows is the exception, 1.48x), and at 10 rows the bytes go out ungzipped, so they are
  larger than gzip JSON.

## Reproduce

```sh
FLIGHTS=.../flights.jsonl LLAVA=.../llava_v1_5_mix665k.json ISSUES=.../issues.jsonl ./run.sh
```

`run.sh` installs `packmem@0.3.0` and `playwright-core` (`package.json`), downloads Chromium, writes the data with
`../wire-size/prep.py` (where to get each source is in `run.sh`), runs `bench.mjs` per dataset and writes
`results/tables.md`. The data files are not in the repository.

## Files

- `bench.mjs`: the server, the payloads and the browser runs. `page.js`, `page.html`: what runs in the page.
- `summarize.mjs`: tables from the runs. `run.sh`: everything in order.
- `results/runs.jsonl`: one line per run. `results/tables.md`, `results/load.jsonl`, `results/machine.txt`,
  `results/data.txt`.
- `results/runs-gzip-main-90602dc.jsonl`, `results/tables-gzip-main-90602dc.md`, `results/load-gzip-main-90602dc.jsonl`:
  the gzip pass. `bench.mjs data out.jsonl 7 <dataset> <sizes> gzip:local,gzip:20mbit` runs it.
