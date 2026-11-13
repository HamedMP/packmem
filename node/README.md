# packmem for Node

An array of records in a fraction of the memory. Records are stored as packed columns that you can still
index, iterate, append to and update, that can be filtered and aggregated without unpacking, and that are
written to JSON straight from the columns, without building objects.

```sh
npm install packmem
```

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
rows.splice(10, 2); rows.insert(0, { ... }); rows.pop(); rows.reverse();
rows.sort({ key: "dest" }); rows.sort((a, b) => a.delay - b.delay);
for (const r of rows.lazy()) total += r.distance; // reads only the fields the loop touches
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
speed: in the Express and Next.js demos, single exports ranged from 4% slower than `res.json` to 1.2 times
faster (`../demos/README.md`).

## Loading

| Before | After |
| --- | --- |
| `text.split("\n").map(JSON.parse)` | `loadJsonl(path)` or `parse(textOrBuffer)` |
| `JSON.parse(readFileSync(path))` for an array of records | `loadJson(path)` (streamed) or `parse(buffer)` |
| any array or iterable of objects | `new Table(records)` or `from(records)` |
| a CSV or TSV file | `loadCsv(path)`, `loadTsv(path)` or `parseCsv(textOrBuffer)` |

CSV is parsed in Rust in chunks (RFC 4180 quoting, CRLF, line breaks inside quotes). Values are inferred (integers,
then decimals, else text; codes with a leading zero such as `007` stay text) unless `types` names them per column
(`"text"`, `"int"`, `"float"`, `"bool"`, `"json"`). An empty field is the empty string, as Python's csv module reads
it, or null with `emptyIsNull: true`; in a typed numeric, boolean or JSON column it is always null.

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

// fastest: COPY ... TO STDOUT as CSV, parsed in Rust; needs pg-copy-streams, and the query takes no parameters
import { to as copyTo } from "pg-copy-streams";
const all = await fromPgCopy(client, "select * from flights", { copyTo });

// a query built with Drizzle (.toSQL()) or Kysely (.compile()), or { sql, params }
const recent = await fromQuery(client, db.select().from(orders).where(gt(orders.total, 100)));
```

`fromPg` needs `pg-cursor` (an optional peer dependency); pass its class as `Cursor`, or let packmem import
it. Values arrive as node-postgres types them: `int8` and `numeric` as strings, timestamps as ISO strings,
`jsonb` as nested values. Any table or iterable of arrays works the same way through
`table.extendArrays(columnNames, rows)`.

`fromPg` is slower than a plain object-mode query, because rows cross into Rust as JSON text and are parsed a second
time. `fromPgCopy` avoids that: no row objects are built in the driver or in JavaScript, and on the flight data it
loaded as fast as plain node-postgres rows (see the timings below). It types values as node-postgres does (int8 and
numeric as strings, json as nested values) except dates and timestamps, which stay as Postgres prints them, in the
session's time zone, instead of becoming `Date`s.

## WebAssembly: Cloudflare Workers, Deno, browsers

Where a native addon cannot load, `packmem/wasm` gives the same API (without file paths and Node streams), compiled
to WebAssembly from the same Rust source as the addon and tested to return identical results.

```js
// Cloudflare Workers: the .wasm file is imported as a compiled module
import wasm from "packmem/wasm/packmem.wasm";
import { initSync } from "packmem/wasm";

const pm = initSync(wasm);
const events = pm.parse(await (await fetch(url)).arrayBuffer());
return new Response(events.where({ status: 404 }).jsonWebStream());
```

Elsewhere, `const pm = await init(bytesOrResponseOrUrl)`. A Worker has 128 MB of memory: in `../demos/workers`,
200,000 generated log rows take 0.69 MB packed, and filtered aggregates answer in a few milliseconds under `wrangler dev`.

## What to expect

Measured on 336,776 flight records (nycflights13, 104 MB as JSON lines), Apple M4 Pro. Every figure here
comes from a recorded results file.

| In-process, flights data | Plain JS, ms | packmem, ms |
| --- | --- | --- |
| All 336,776 rows as JSON bytes | 128.78 | 113.39 |
| Group by dest where carrier = UA | 3.36 | 0.75 |
| Sum distance where origin = JFK | 3.4 | 1.3 |
| Load the flights table from Postgres | 439.34 | 959.59 |

Recorded in `bench/results/darwin-arm64.json` by `bench/micro.mjs`: Apple M4 Pro, Node v22.22.3, median of 9, load average 10.93 before and 9.97 after (desktop applications were busy; expect noise of tens of percent).

In the demo servers (`../demos/README.md`, recorded in `../demos/bench/results/`, load average recorded per run):

- Packed size 8.1 MB. An Express or Next.js server holding the data settles at 94 to 118 MB against 390 to
  411 MB with an array of objects loaded from the file, and 100 to 125 MB against 200 to 222 MB loaded
  from Postgres: 1.8 to 4.1 times less. Peak memory while serving is 3.6 to 5.3 times lower.
- Filtered pages are 1.8 to 3.4 times faster than JS loops and group-by 2.0 to 4.7 times faster; the
  summary query (count, sum and a nested filter) is level to 1.7 times faster.
- Single exports range from 4% slower to 1.2 times faster; concurrent exports are 1.2 to 1.8 times faster. Iterating every row builds plain objects through
  `JSON.parse` in batches, so a loop over all rows costs about as much as parsing the JSON again.

In Node the gain is mainly memory. V8 already stores objects of the same shape compactly, so the ratio is
smaller than in Python, where the same servers used 3.7 to 10.2 times less memory at rest.

## Semantics to know

- Values go in and come out as through `JSON.stringify` / `JSON.parse`: `-0` becomes `0`, `undefined`
  values are dropped, `Date` becomes a string, integers beyond 2^53 lose precision when read back as
  numbers. Loaded integers beyond 64 bits stay exact in the table and in JSON output.
- A returned row is a fresh object; mutating it does not change the table. Use `set` or `update`.
- Key order in returned objects is the order columns were first seen.
- `sum` adds numbers and booleans and skips everything else.
- `sort`, `splice`, `insert`, `pop`, `shift`, `unshift` and `reverse` each rebuild the table once, so they cost time
  proportional to its size; batch them where you can.
- Lazy rows (`rows.lazy()`) read one column per batch of 4,096 rows, only for the fields a loop touches: on the
  flight data a loop reading one field took 23 ms against 343 ms with full objects. A loop over a plain array is
  still faster (2.4 ms); for whole-column work use `rows.column(name)` or a query.
- Strings with unpaired UTF-16 surrogates (`"\udd56"`, which `JSON.parse` accepts) are stored and read back
  exactly.
- `rows[i]` does not work; use `rows.at(i)`. A `Table` is iterable and has `length`, but it is not an
  `Array`, so `Array.isArray` is false and array methods beyond `map`, `filter`, `forEach` and `reduce`
  need `toArray()` first.
- The package is an ES module. CommonJS code can `require` it on Node 22.12 or later; older Node needs
  `await import("packmem")`.
- A load error names the record or line in the whole input (`record 4100: ...`).

## Build

Needs Rust and Node 18 or later.

    npm run build     # cargo build --release, then copies the addon to packmem.<platform>-<arch>.node
    npm test          # model tests against plain arrays, and a full round trip of data/flights.jsonl if present

Status: alpha. CI builds and tests the addon on Linux (x86-64 and arm64), macOS and Windows with Node 20
and 22, and against Postgres 17.

The npm package includes prebuilt addons for Linux x86-64 and arm64 (glibc 2.34 or later: Debian 12,
Ubuntu 22.04, RHEL 9 and newer), macOS on Apple silicon, and Windows x64. It does not yet cover Alpine or
other musl systems, Amazon Linux 2, or Intel Macs; there, build from source with `npm run build` (needs
Rust). There is no WebAssembly build (for Cloudflare Workers and browsers) and no CSV or TSV loader yet.

## Prior work

None of the encodings is new: analytical databases use them, notably BtrBlocks and Vortex, and the string
scheme is FSST (Boncz, Neumann, Leis, VLDB 2020). What packmem adds is putting them behind the containers
programs already use: here, an array of objects.
