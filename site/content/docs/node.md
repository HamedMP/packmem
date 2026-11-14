# Node

`Table` is an array-like collection of records stored as packed columns, for Node 20+, Bun and Deno. Rows come
back as plain objects.

```sh
npm install packmem
```

## Load

| Before | After |
| --- | --- |
| `text.split("\n").map(JSON.parse)` | `loadJsonl(path)` or `parse(textOrBytes)` |
| `JSON.parse(readFileSync(path))` for an array of records | `loadJson(path)` (streamed) or `parse(bytes)` |
| an array or iterable of objects | `new Table(records)` or `from(records)` |
| a CSV or TSV file | `loadCsv(path)`, `loadTsv(path)` or `parseCsv(textOrBytes)` |
| a Postgres query | `fromPg`, `fromPgCopy`, `fromPgResult`, `fromQuery` (below) |

Parsing happens in Rust, straight into columns. Skip `JSON.parse` to get the memory benefit: once V8 has built
the objects, the peak memory is spent. Every loader takes `{ hint }`: `"balanced"` (default), `"memory"` or
`"speed"`.

CSV options: `delimiter`, `header` (default true), `names`, `types` per column (`"infer"`, `"text"`, `"int"`,
`"float"`, `"bool"`, `"json"`) and `emptyIsNull`.

## Use it as an array

```js
rows.length; rows.at(0); rows.at(-1); rows.slice(10, 20);
for (const r of rows) {}                         // plain objects, built in batches
rows.map(fn); rows.filter(fn); rows.reduce(fn, init); rows.forEach(fn); rows.toArray();
rows.push({ ... }); rows.extend(iterable);
rows.set(3, { ... });                            // replace a record
rows.update(3, { status: 500, note: undefined }); // change fields; undefined removes a key
rows.splice(10, 2); rows.insert(0, { ... }); rows.pop(); rows.shift(); rows.unshift({ ... });
rows.reverse(); rows.clear();
rows.sort({ key: "dest" }); rows.sort((a, b) => a.delay - b.delay);
rows.take([3, 1, 2]); rows.copy();
```

`rows[i]` does not work; use `rows.at(i)`. A `Table` is iterable and has `length` but is not an `Array`.
`sort`, `splice`, `insert`, `pop`, `shift`, `unshift` and `reverse` each rebuild the table once.

## Query the packed data

```js
rows.count({ status: 404 });
rows.sum("bytes", { ua: { contains: "curl" } });
rows.groupCount("country", { path: { prefix: "/api/" } });
rows.column("dest", { carrier: "UA" });

const v = rows.where({ carrier: "UA", dep_delay: { gt: 60 } }); // a View
v.length; v.ids; v.sum("distance"); v.groupCount("dest");
v.rows({ offset: 0, limit: 50 });                // a page of objects
v.rowsJsonBuffer({ offset: 0, limit: 50 });      // the same page as JSON bytes, no objects
```

Filters: `{ col: value }` for equality, or `{ col: { eq, gt, gte, lt, lte, between: [lo, hi], prefix, contains } }`.
Every condition must hold.

## Loops that read a few fields

```js
for (const r of rows.lazy()) total += r.distance; // reads only the fields the loop touches
```

A lazy row has the column names as properties, `get(name)`, `toObject()` and `index`. Assigning a field writes to
the table.

## JSON responses without objects

```js
rows.where({ carrier: "UA" }).jsonStream().pipe(res);   // Express, Fastify, node:http
return new Response(rows.where({ carrier: "UA" }).jsonWebStream(), {
  headers: { "content-type": "application/json" },       // Next.js route handlers, Hono, Bun, Deno
});
rows.jsonBuffer();                                       // one Buffer
for (const chunk of rows.jsonChunks({ batch: 4096 })) {} // Buffers, one batch at a time
```

For flat records the bytes are the same as `JSON.stringify`. To send a table as packed bytes instead, see
[packmem/http](/docs/http/).

## Postgres

```js
import pg from "pg";
import Cursor from "pg-cursor";
import { fromPg, fromPgCopy, fromPgResult, fromQuery } from "packmem";
import { to as copyTo } from "pg-copy-streams";

const flights = await fromPg(client, "select * from flights where year = $1", [2013], { Cursor });
const all = await fromPgCopy(client, "select * from flights", { copyTo }); // COPY as CSV; no parameters
const small = fromPgResult(await client.query({ text: "select * from airports", rowMode: "array" }));
const recent = await fromQuery(client, drizzleOrKyselyQuery);                // .toSQL(), .compile() or { sql, params }
```

`pg-cursor` and `pg-copy-streams` are optional peer dependencies. `fromPgCopy` is the fastest: no row objects
are built in the driver or in JavaScript.

## Worker threads

```js
// main thread
const rows = loadJsonl("logs.jsonl");
new Worker("./worker.js", { workerData: rows.share() });

// worker.js
import { workerData } from "node:worker_threads";
import { Table } from "packmem";
const rows = Table.fromShared(workerData);
```

`share()` makes the table read-only and returns a small handle; workers read the same memory, with no copy.
`unshare()` makes it writable again; `copy()` gives a private table. This covers the threads of one process.

## Bytes

```js
const bytes = rows.toBytes();          // Uint8Array
const back = Table.fromBytes(bytes);   // also ArrayBuffer or any ArrayBufferView
```

The same form Python's `to_bytes` writes. See [Byte format](/docs/format/) and [packmem/http](/docs/http/).

## Inspect

```js
rows.names;       // column names
rows.nbytes;      // bytes held by the packed columns
rows.describe();  // [{ name, encoding, bytes }]
rows.compact();   // pack rows still held uncompressed (done automatically)
```

## Semantics

- Values go in and come out as through `JSON.stringify` and `JSON.parse`: `-0` becomes `0`, `undefined` values
  are dropped, a `Date` becomes a string.
- A returned row is a fresh object; mutating it does not change the table. Use `set` or `update`.
- `sum` adds numbers and booleans and skips everything else.
- The package is an ES module; CommonJS can `require` it on Node 22.12 or later.

The full list is in [node/README.md](https://github.com/HamedMP/packmem/blob/main/node/README.md).
