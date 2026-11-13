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

Output is byte-identical to `JSON.stringify` of the same records (tested on all 336,776 flight records).
On that data, writing every row takes 107 ms against 140 ms for `Buffer.from(JSON.stringify(array))`,
and only one batch of bytes exists at a time.

## Loading

| Before | After |
| --- | --- |
| `text.split("\n").map(JSON.parse)` | `loadJsonl(path)` or `parse(textOrBuffer)` |
| `JSON.parse(readFileSync(path))` for an array of records | `loadJson(path)` (streamed) or `parse(buffer)` |
| any array or iterable of objects | `new Table(records)` or `from(records)` |

Parsing happens in Rust, straight into columns. `JSON.parse` must be skipped to get the memory benefit:
once V8 has built the objects, the peak memory is already spent.

## What to expect

Measured on 336,776 flight records (nycflights13, 104 MB as JSON lines), Apple M4 Pro:

- Packed size 8.1 MB. A whole web server holding the data idles at 96 to 126 MB RSS against 528 to 552 MB
  with an array of objects (see `../demos`).
- Filtered pages are about 2 times faster than plain JS loops, and a filtered group-by 2 to 4 times
  faster (0.68 ms against 2.8 ms in-process). A filter plus a sum is level with a JS loop: V8 scans
  same-shape objects quickly.
- Iterating every row builds plain objects through `JSON.parse` in batches, so a loop over all rows costs
  about as much as parsing the JSON again.

In Node the gain is memory, not speed. V8 already stores objects of the same shape compactly, so the ratio
is smaller than Python's (about 5 times against 10 to 30 times).

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

Status: alpha. macOS arm64 built and tested. Linux and Windows builds, prebuilt binaries per platform and
a WASM build (for Cloudflare Workers and browsers) are not done.
