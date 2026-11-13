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
taken right after loading partly measures garbage-collector timing. The machine was in normal use
(load average 5 to 10, recorded in the results files), so treat timing differences under about 15% as
noise.

**Loaded from the JSON-lines file**

Source: file. Apple M4 Pro, 12 cores, Node v22.22.3, load average 5.34 before and 10.36 after. Every response was identical between modes.

|  | Express baseline | Express packmem | Next.js baseline | Next.js packmem | FastAPI baseline | FastAPI packmem |
| --- | --- | --- | --- | --- | --- | --- |
| RSS 1 s after load, MB | 422 | 97 | 450 | 130 | 731 | 72 |
| Idle RSS, settled, MB | 386 | 94 | 411 | 119 | 731 | 72 |
| Peak RSS during the run, MB | 797 | 186 | 979 | 209 | 1,619 | 106 |
| Load, ms | 333 | 272 | 376 | 370 | 787 | 312 |
| Page of 50 rows, ms | 3.83 | 2.10 | 6.04 | 4.09 | 124 | 2.39 |
| Group by dest, ms | 2.67 | 1.24 | 4.64 | 2.89 | 81.7 | 1.35 |
| Summary, ms | 2.87 | 2.68 | 4.82 | 4.44 | 81.5 | 3.28 |
| Export 58,665 rows, ms | 37.8 | 40.5 | 201 | 236 | 279 | 78.4 |
| Export all 336,776 rows, ms | 210 | 230 | 930 | 968 | 749 | 366 |
| 8 concurrent exports of 58,665 rows, wall ms | 312 | 233 | 1,297 | 564 | 2,108 | 544 |

**Loaded from Postgres 17** (node-postgres object rows and psycopg `dict_row` against `fromPg` and
`packmem.from_cursor`; in this run the psycopg baseline used a client-side `fetchall` and packmem a named
cursor fetching 50,000 rows at a time)

Source: postgres. Apple M4 Pro, 12 cores, Node v22.22.3, load average 10.36 before and 8.51 after. Every response was identical between modes.

|  | Express baseline | Express packmem | Next.js baseline | Next.js packmem | FastAPI baseline | FastAPI packmem |
| --- | --- | --- | --- | --- | --- | --- |
| RSS 1 s after load, MB | 226 | 184 | 251 | 228 | 533 | 118 |
| Idle RSS, settled, MB | 199 | 101 | 222 | 128 | 533 | 118 |
| Peak RSS during the run, MB | 824 | 194 | 1,041 | 205 | 1,418 | 158 |
| Load, ms | 615 | 1,133 | 558 | 1,023 | 581 | 677 |
| Page of 50 rows, ms | 7.61 | 2.26 | 8.34 | 3.34 | 91.5 | 1.95 |
| Group by dest, ms | 6.27 | 1.38 | 6.00 | 2.31 | 40.6 | 1.46 |
| Summary, ms | 6.02 | 3.30 | 5.88 | 3.61 | 42.1 | 2.84 |
| Export 58,665 rows, ms | 74.0 | 66.8 | 243 | 188 | 204 | 66.1 |
| Export all 336,776 rows, ms | 244 | 315 | 999 | 964 | 698 | 312 |
| 8 concurrent exports of 58,665 rows, wall ms | 497 | 333 | 884 | 845 | 1,814 | 420 |

Reading it:

- **Memory is the consistent result, and the peak is where it shows most.** Peak memory while serving was
  4.2 to 5.1 times lower in Node and 9 to 15 times lower in FastAPI, from either source.
- **Settled memory depends on the runtime and the source.** From the file: 4.1x (Express), 3.5x
  (Next.js), 10.2x (FastAPI). From Postgres the Node baselines are lighter (node-postgres rows took about
  half the memory of `JSON.parse` here), so the saving is 1.7 to 2.0x in Node and 4.5x in FastAPI.
- **Python gets faster too.** Filters and aggregates are 15 to 60 times faster than loops over dicts, and
  exports 2 to 3.6 times faster.
- **Node is ahead on queries and mixed on exports.** packmem is faster on filtered pages and group-by
  (1.5 to 4.5x) and level to 1.8x faster on the summary. Single exports land within about 30% either way,
  with no consistent winner; concurrent exports are level to 2.3x faster because no full-size string is
  built per request.
- **Loading from Postgres is slower in Node.** `fromPg` took about 1.8 times as long as a plain query (rows
  cross into the native code as JSON text). In the recorded Python run, `from_cursor` took 1.17 times
  as long as psycopg's `dict_row` (677 against 581 ms), but the two did not fetch the same way: the
  baseline fetched everything in one round trip and packmem used a named cursor. The demo now uses the
  same named cursor for both, and this table will be replaced by a like-for-like run.
- **Next.js exports are slow in both modes**, so that cost is in Next's web-stream response path, not in
  packmem.

### Caveats

- One machine, one dataset, client and server (and Postgres) on the same host, not otherwise idle. Small-endpoint timings include about
  0.5 ms of HTTP overhead.
- The baselines are written the way an informed developer would write them. The FastAPI baseline uses
  `json.dumps` directly instead of FastAPI's slower default encoder, and Node uses `JSON.stringify`.
- The data is read-only during the run. Neither demo mutates records under load.
