# packmem for Node

An array of records in a fraction of the memory. Records are stored as packed columns that you can still
index, iterate, append to and update, that can be filtered and aggregated without unpacking, and that are
written to JSON straight from the columns, without building objects.

```js
import { loadJsonl } from "packmem";

const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse); // before
const rows = loadJsonl(path);                                                          // after
```

`rows` keeps working as a sequence of plain objects:

```js
rows.length; rows.at(0); rows.at(-1); rows.slice(10, 20);
for (const r of rows) {}                      // plain objects, built 4,096 at a time
rows.map(fn); rows.filter(fn); rows.reduce(fn, init);
rows.push({ ... }); rows.extend(iterable);
rows.set(3, { ... });                         // replace a record
rows.update(3, { status: 500, note: undefined }); // change fields; undefined removes a key
```

and gains queries that run on the packed data:

```js
rows.count({ status: 404 });
rows.sum("bytes", { ua: { contains: "curl" } });
rows.groupCount("country", { path: { prefix: "/api/" } });
rows.where({ carrier: "UA", dep_delay: { gt: 60 } }).rows({ offset: 0, limit: 50 });
```

Filters: `{ col: value }` for equality, or `{ col: { eq, gt, gte, lt, lte, between: [lo, hi], prefix, contains } }`.
Every condition must hold.

## JSON responses without objects

```js
// Express, Fastify, node:http
rows.where({ carrier: "UA" }).jsonStream().pipe(res);

// Next.js route handlers, Hono, Bun, Deno, any fetch-style server
return new Response(rows.where({ carrier: "UA" }).jsonWebStream(), { headers: { "content-type": "application/json" } });

// one buffer
rows.jsonBuffer();
```

Numbers are written by the same rules as `JSON.stringify`, so for flat records the output is
byte-identical (tested on all 336,776 flight records and on edge values such as `1e-7`, `1e21` and
`5e-324`). Numbers inside nested arrays and objects loaded from JSON text are not reformatted (`1.0` stays `1.0`,
`2.50` stays `2.50`), so those bytes can differ from `JSON.stringify` while the values are equal. Only one batch of bytes exists at a time; see the timings below. Over HTTP the gain is memory, not
speed: in the Express demo a full export was 10% slower than `res.json` from the file and 29% slower from
Postgres (`../demos/README.md`).

## Loading

| Before | After |
| --- | --- |
| `text.split("\n").map(JSON.parse)` | `loadJsonl(path)` or `parse(textOrBuffer)` |
| `JSON.parse(readFileSync(path))` for an array of records | `loadJson(path)` (streamed) or `parse(buffer)` |
| any array or iterable of objects | `new Table(records)` or `from(records)` |

Parsing happens in Rust, straight into columns. `JSON.parse` must be skipped to get the memory benefit:
once V8 has built the objects, the peak memory is already spent.

## Postgres

```js
import pg from "pg";
import Cursor from "pg-cursor";
import { fromPg, fromPgResult } from "packmem";

const client = new pg.Client(url);
await client.connect();

// streamed through a cursor in array mode: no object per row on either side
const flights = await fromPg(client, "select * from flights where year = $1", [2013], { Cursor });

// or from a result you already have
const small = fromPgResult(await client.query({ text: "select * from airports", rowMode: "array" }));
```

`fromPg` needs `pg-cursor` (an optional peer dependency); pass its class as `Cursor`, or let packmem import
it. Values arrive as node-postgres types them: `int8` and `numeric` as strings, timestamps as ISO strings,
`jsonb` as nested values. Any table or iterable of arrays works the same way through
`table.extendArrays(columnNames, rows)`.

Loading is slower than a plain object-mode query, because rows cross into Rust as JSON text and are parsed
a second time; see the last row of the timings below. The memory saving is about the same as from a file.

## What to expect

Measured on 336,776 flight records (nycflights13, 104 MB as JSON lines), Apple M4 Pro. Every figure here
comes from a recorded results file.

| In-process, flights data | Plain JS, ms | packmem, ms |
| --- | --- | --- |
| All 336,776 rows as JSON bytes | 161.12 | 128.51 |
| Group by dest where carrier = UA | 4.87 | 0.76 |
| Sum distance where origin = JFK | 3.45 | 1.37 |
| Load the flights table from Postgres | 473.12 | 1100.17 |

Recorded in `bench/results/darwin-arm64.json` by `bench/micro.mjs`: Apple M4 Pro, Node v22.22.3, median of 9, load average 13.98 (the machine was busy; expect noise of tens of percent).

In the demo servers (`../demos/README.md`, recorded in `../demos/bench/results/`, load average 5 to 10):

- Packed size 8.1 MB. An Express or Next.js server holding the data settles at 94 to 119 MB against 386 to
  411 MB with an array of objects loaded from the file, and 101 to 128 MB against 199 to 222 MB loaded
  from Postgres: 1.7 to 4.1 times less. Peak memory while serving is 4.2 to 5.1 times lower.
- Filtered pages are 1.5 to 3.4 times faster than JS loops and group-by 1.6 to 4.5 times faster; the
  summary query (count, sum and a nested filter) is level to 1.8 times faster.
- Single exports are within about 30% either way. Iterating every row builds plain objects through
  `JSON.parse` in batches, so a loop over all rows costs about as much as parsing the JSON again.

In Node the gain is mainly memory. V8 already stores objects of the same shape compactly, so the ratio is
smaller than in Python, where the same servers used 4.5 to 10 times less memory at rest.

## Semantics to know

- Values go in and come out as through `JSON.stringify` / `JSON.parse`: `-0` becomes `0`, `undefined`
  values are dropped, `Date` becomes a string, integers beyond 2^53 lose precision when read back as
  numbers. Loaded integers beyond 64 bits stay exact in the table and in JSON output.
- A returned row is a fresh object; mutating it does not change the table. Use `set` or `update`.
- Key order in returned objects is the order columns were first seen.
- `sum` adds numbers and booleans and skips everything else.
- No `sort`, `splice` or `delete` yet.

## Build

Needs Rust and Node 18 or later.

    npm run build     # cargo build --release, then copies the addon to packmem.<platform>-<arch>.node
    npm test          # model tests against plain arrays, and a full round trip of data/flights.jsonl if present

Status: alpha. CI builds and tests the addon on Linux (x86-64 and arm64), macOS and Windows with Node 20
and 22, and against Postgres 17. Prebuilt binaries are not published yet, and there is no WebAssembly
build (for Cloudflare Workers and browsers).

## Prior work

None of the encodings is new: analytical databases use them, notably BtrBlocks and Vortex, and the string
scheme is FSST (Boncz, Neumann, Leis, VLDB 2020). What packmem adds is putting them behind the containers
programs already use: here, an array of objects.
