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

One pass over all three demos. Every response was identical between modes. The machine was not idle
(load average 7.8 before, 6.8 after, on 12 cores; recorded in the results file), so treat differences
under about 15% as noise.

| | Express baseline | Express packmem | Next.js baseline | Next.js packmem | FastAPI baseline | FastAPI packmem |
| --- | --- | --- | --- | --- | --- | --- |
| Idle RSS after load, MB | 527 | 97 | 552 | 126 | 731 | 69 |
| Peak RSS during the run, MB | 727 | 173 | 864 | 228 | 1,365 | 116 |
| Load, ms | 445 | 265 | 362 | 275 | 636 | 261 |
| Page of 50 filtered rows, ms | 3.83 | 1.91 | 5.66 | 3.69 | 113 | 1.98 |
| Group by destination, ms | 2.86 | 1.09 | 4.29 | 2.26 | 51.0 | 1.32 |
| Summary (count, sum, nested filter), ms | 2.99 | 2.59 | 4.20 | 3.89 | 61.9 | 2.78 |
| Export 58,665 rows (18 MB), ms | 40.9 | 39.5 | 200 | 198 | 207 | 63.2 |
| Export all 336,776 rows (104 MB), ms | 206 | 237 | 890 | 916 | 636 | 287 |
| 8 concurrent exports of 58,665 rows, wall ms | 326 | 236 | 1,006 | 523 | 1,612 | 416 |

Reading it:

- **Memory is the consistent result.** Node servers idle at 4.4 to 5.4 times less memory and peak 3.8 to
  4.2 times lower. FastAPI idles at 10.6 times less and peaks 11.8 times lower, because a Python dict
  costs more than a V8 object.
- **Python gets faster too.** Filters and aggregates are 22 to 57 times faster than loops over dicts, and
  exports 2.2 to 3.9 times faster.
- **Node is level or ahead on speed.** packmem is faster on filtered pages (1.5 to 2x) and group-by
  (1.9 to 2.6x), level on the summary, and level on single exports. Under concurrent exports it is
  1.4 to 1.9 times faster, because it never builds a full-size string per request.
- **Next.js exports are slow in both modes.** The same export takes 4 times longer than in Express in both
  modes, so the cost is in Next's web-stream response path, not in packmem.
- Load time includes parsing: packmem parses JSON in Rust straight into columns, so it loads faster than
  `JSON.parse` per line, and 2.5 times faster than `json.loads` per line in Python.

### Caveats

- One machine, one dataset, client and server on the same host, not otherwise idle. Small-endpoint timings include about
  0.5 ms of HTTP overhead.
- The baselines are written the way an informed developer would write them. The FastAPI baseline uses
  `json.dumps` directly instead of FastAPI's slower default encoder, and Node uses `JSON.stringify`.
- The data is read-only during the run. Neither demo mutates records under load.
