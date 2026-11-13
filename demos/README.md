# packmem demos: the same API on Express, Next.js and FastAPI

Each demo serves 336,776 flight records (`data/flights.jsonl`, nycflights13, 104 MB) from memory. One
environment variable switches how the data is held:

- `MODE=baseline`: what the code would normally do: an array of objects (Node), a list of dicts (Python).
- `MODE=packmem` (default): a packmem table. JSON responses are written from the packed columns.

All three expose the same routes:

| Route | What it does |
| --- | --- |
| `GET /api/health` | mode, rows, load time, process memory |
| `GET /api/flights?carrier=UA&origin=JFK&dest=LAX&min_delay=60&limit=50&offset=0` | filtered page of rows and the total |
| `GET /api/stats/by-dest?carrier=UA` | group by destination, count |
| `GET /api/stats/summary?origin=JFK` | count, total distance, departures over 60 minutes late |
| `GET /api/flights/export?carrier=UA` | every matching row as one JSON array, streamed |

## Run

Build the Node addon once: `cd node && npm run build`. The Python demo uses the wheel in `python/dist`.

```sh
# Express (port 3001)
cd demos/express && npm install && npm start            # or npm run start:baseline

# Next.js (port 3002): a dashboard at / plus the API
cd demos/nextjs && npm install && npm run build && npm start   # or npm run start:baseline

# FastAPI (port 3003 here; any port works)
cd demos/fastapi
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt ../../python/dist/packmem-*.whl
MODE=packmem .venv/bin/uvicorn app:app --port 3003
```

### From Postgres instead of the file

Set `FLIGHTS_PG_URL` and every demo loads the `flights` table instead of the file: node-postgres object
rows or psycopg dict rows in baseline mode, `fromPg` (Node) or `packmem.from_cursor` (Python) in packmem
mode. To create the table from the CSV that `benchmarks/fetch_data.py` writes:

```sh
psql "$FLIGHTS_PG_URL" <<'SQL'
create table flights (
  year int, month int, day int, dep_time float8, sched_dep_time int, dep_delay float8, arr_time float8,
  sched_arr_time int, arr_delay float8, carrier text, flight int, tailnum text, origin text, dest text,
  air_time float8, distance int, hour int, minute int, time_hour text
);
\copy flights from 'data/flights.csv' with (format csv, header true)
SQL
FLIGHTS_PG_URL=postgres://localhost/flights npm start      # any of the demos
```

The Next.js demo installs packmem as a copy (`.npmrc`: `install-links=true`), because a symlinked native
package resolves outside `node_modules` and Turbopack then tries to bundle it. `npm run build` refreshes
the copy first, so rebuilding the addon only needs a rebuild of the app.

## Benchmark

```sh
node demos/bench/bench.mjs                # all three, both modes, one server at a time
node demos/bench/bench.mjs fastapi        # or a subset
```

It starts each server, waits for it to load, then times each endpoint from a client on the same machine
(median of 30 requests for small endpoints, 5 or 3 for exports). It samples the resident memory of the
server's whole process tree every 40 ms, and checks that every response in packmem mode equals the
baseline response (compared after parsing, with keys sorted). Results go to `bench/results/`.

### Results, Apple M4 Pro, Node 22.22, Python 3.12

Memory is the resident size of the whole server process tree. "Settled" is measured after a forced
garbage collection and 20 seconds idle: runtimes hand freed memory back to the system lazily, so a reading
taken right after loading partly measures garbage-collector timing. Each framework is launched once,
untimed, before it is measured, so one-off costs of a freshly built binary stay out of the numbers. Load
averages are recorded per run; treat timing differences under about 15% as noise, more where the load
average was high.

**Loaded from the JSON-lines file**

Source: file. Apple M4 Pro, 12 cores, Node v22.22.3; 1-minute load average at the start of each run: Express 2.96 to 3.22, Next.js 2.96 to 3.22, FastAPI 5.96 to 7.22. Some frameworks were re-run separately and merged into this file. Every response was identical between modes.

|  | Express baseline | Express packmem | Next.js baseline | Next.js packmem | FastAPI baseline | FastAPI packmem |
| --- | --- | --- | --- | --- | --- | --- |
| RSS 1 s after load, MB | 423 | 97 | 441 | 129 | 731 | 72 |
| Idle RSS, settled, MB | 390 | 94 | 411 | 118 | 731 | 72 |
| Peak RSS during the run, MB | 798 | 197 | 1,109 | 210 | 1,619 | 105 |
| Load, ms | 313 | 265 | 320 | 272 | 625 | 253 |
| Page of 50 rows, ms | 3.44 | 1.59 | 4.79 | 2.63 | 104 | 1.89 |
| Group by dest, ms | 2.60 | 0.87 | 3.14 | 1.55 | 60.2 | 1.23 |
| Summary, ms | 2.47 | 2.31 | 3.11 | 3.05 | 59.6 | 2.38 |
| Export 58,665 rows, ms | 38.8 | 36.9 | 161 | 159 | 202 | 51.0 |
| Export all 336,776 rows, ms | 167 | 174 | 834 | 837 | 617 | 278 |
| 8 concurrent exports of 58,665 rows, wall ms | 271 | 197 | 488 | 401 | 1,621 | 397 |

**Loaded from Postgres 17** (node-postgres object rows and psycopg `dict_row` against `fromPg` and
`packmem.from_cursor`; both Python modes read through the same named cursor, 50,000 rows per round trip)

Source: postgres. Apple M4 Pro, 12 cores, Node v22.22.3; 1-minute load average at the start of each run: Express 3.22 to 10.49, Next.js 3.22 to 10.49, FastAPI 3.22 to 10.49. Every response was identical between modes.

|  | Express baseline | Express packmem | Next.js baseline | Next.js packmem | FastAPI baseline | FastAPI packmem |
| --- | --- | --- | --- | --- | --- | --- |
| RSS 1 s after load, MB | 228 | 183 | 252 | 224 | 439 | 118 |
| Idle RSS, settled, MB | 200 | 100 | 222 | 125 | 439 | 118 |
| Peak RSS during the run, MB | 823 | 226 | 1,039 | 209 | 1,325 | 156 |
| Load, ms | 461 | 997 | 457 | 963 | 726 | 733 |
| Page of 50 rows, ms | 5.29 | 1.56 | 6.00 | 2.46 | 82.1 | 2.04 |
| Group by dest, ms | 4.42 | 0.94 | 4.68 | 1.54 | 41.0 | 1.17 |
| Summary, ms | 4.10 | 2.36 | 4.27 | 2.88 | 41.2 | 2.45 |
| Export 58,665 rows, ms | 42.7 | 35.8 | 159 | 158 | 190 | 48.0 |
| Export all 336,776 rows, ms | 189 | 166 | 835 | 829 | 570 | 271 |
| 8 concurrent exports of 58,665 rows, wall ms | 358 | 196 | 553 | 395 | 1,499 | 395 |

Reading it:

- **Memory is the consistent result, and the peak is where it shows most.** Peak memory while serving was
  3.6 to 5.3 times lower in Node and 8.5 to 15.4 times lower in FastAPI.
- **Settled memory depends on the runtime and the source.** From the file: 4.1x (Express), 3.5x
  (Next.js), 10.2x (FastAPI). From Postgres the Node baselines are lighter (node-postgres rows took about
  half the memory of `JSON.parse` here), so the saving is 1.8 to 2.0x in Node and 3.7x in FastAPI.
- **Python gets faster too.** Filters and aggregates are 17 to 55 times faster than loops over dicts, and
  exports 2.1 to 4.0 times faster.
- **Node is ahead on queries and level on exports.** packmem is faster on filtered pages (1.8 to 3.4x)
  and group-by (2.0 to 4.7x), and level to 1.7x faster on the summary. Single exports range from 4%
  slower to 1.2x faster; concurrent exports are 1.2 to 1.8 times faster because no full-size string is
  built per request.
- **Loading from Postgres is slower in Node.** `fromPg` took 2.1 to 2.2 times as long as a plain query
  (rows cross into the native code as JSON text). In Python, `from_cursor` took the same time as
  psycopg's `dict_row` with the same fetch pattern (733 against 726 ms).
- **Next.js exports are slow in both modes**, so that cost is in Next's web-stream response path, not in
  packmem.

### Results on Linux, AMD Ryzen 9 7950X3D, Ubuntu 24.04, Node 24.22, Python 3.12

The same code, data and scripts on a quiet Linux machine (resident set size here; the Mac figures are the
resident size of the process tree, so compare ratios rather than megabytes).

**Loaded from the JSON-lines file**

Source: file. AMD Ryzen 9 7950X3D 16-Core Processor, 32 cores, Node v24.22.0; 1-minute load average at the start of each run: Express 0.6 to 0.84, Next.js 1.03 to 1.1, FastAPI 1.03 to 1.04. Every response was identical between modes.

|  | Express baseline | Express packmem | Next.js baseline | Next.js packmem | FastAPI baseline | FastAPI packmem |
| --- | --- | --- | --- | --- | --- | --- |
| RSS 1 s after load, MB | 205 | 100 | 273 | 141 | 723 | 58 |
| Idle RSS, settled, MB | 205 | 100 | 199 | 131 | 723 | 58 |
| Peak RSS during the run, MB | 644 | 204 | 693 | 229 | 987 | 100 |
| Load, ms | 488 | 299 | 514 | 304 | 1,208 | 291 |
| Page of 50 rows, ms | 4.18 | 2.17 | 5.77 | 3.03 | 182 | 2.87 |
| Group by dest, ms | 5.91 | 1.13 | 8.73 | 1.77 | 120 | 1.79 |
| Summary, ms | 5.56 | 3.14 | 10.2 | 3.38 | 132 | 3.41 |
| Export 58,665 rows, ms | 88.7 | 80.9 | 236 | 203 | 364 | 87.9 |
| Export all 336,776 rows, ms | 610 | 451 | 1,360 | 1,130 | 1,258 | 579 |
| 8 concurrent exports of 58,665 rows, wall ms | 848 | 485 | 1,211 | 775 | 2,810 | 705 |

**Loaded from Postgres 17**

Source: postgres. AMD Ryzen 9 7950X3D 16-Core Processor, 32 cores, Node v24.22.0; 1-minute load average at the start of each run: Express 0.83 to 1.12, Next.js 0.81 to 0.92, FastAPI 1.27 to 1.29. Every response was identical between modes.

|  | Express baseline | Express packmem | Next.js baseline | Next.js packmem | FastAPI baseline | FastAPI packmem |
| --- | --- | --- | --- | --- | --- | --- |
| RSS 1 s after load, MB | 303 | 228 | 354 | 245 | 433 | 111 |
| Idle RSS, settled, MB | 303 | 228 | 240 | 145 | 433 | 111 |
| Peak RSS during the run, MB | 664 | 316 | 794 | 233 | 659 | 153 |
| Load, ms | 670 | 1,250 | 701 | 1,256 | 962 | 958 |
| Page of 50 rows, ms | 8.68 | 1.90 | 40.2 | 3.90 | 154 | 2.56 |
| Group by dest, ms | 10.1 | 1.09 | 39.2 | 2.35 | 67.6 | 2.02 |
| Summary, ms | 9.01 | 3.05 | 40.0 | 33.5 | 80.7 | 3.39 |
| Export 58,665 rows, ms | 118 | 76.5 | 243 | 203 | 285 | 89.7 |
| Export all 336,776 rows, ms | 678 | 448 | 1,401 | 1,129 | 1,212 | 610 |
| 8 concurrent exports of 58,665 rows, wall ms | 1,023 | 496 | 1,370 | 750 | 2,380 | 703 |

- Python saves more on Linux (FastAPI 12.5x at rest) because glibc returns load buffers that the macOS
  allocator keeps. Node saves less (2.0x Express, 1.5x Next.js from the file) because V8 keeps plain
  objects leaner on Linux.
- The Postgres rows are an upper bound for Node. Loading from Postgres leaves freed V8 heap pages that V8
  returns between 60 and 120 seconds after loading on Linux, after these 20-second readings; on the Mac it
  returns them within 20 seconds. `node/bench/settle.mjs` records the timeline
  (`node/bench/results/*-settle.json`): a Postgres-loaded table on Linux held 210 MB until 60 s and 93 MB
  from 120 s.

### Caveats

- One machine, one dataset, client and server (and Postgres) on the same host, not otherwise idle. Small-endpoint timings include about
  0.5 ms of HTTP overhead.
- The baselines are written the way an informed developer would write them. The FastAPI baseline uses
  `json.dumps` directly instead of FastAPI's slower default encoder, and Node uses `JSON.stringify`.
- The data is read-only during the run. Neither demo mutates records under load.
