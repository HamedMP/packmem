---
name: packmem
description: Use packmem to hold large collections of records (Python lists of dicts, JavaScript arrays of objects) in packed columns, query them without unpacking, and send them to browsers as packed bytes. Use when a server, worker or data loader holds many records in memory, when replacing json.load / JSON.parse of a big file, or when a React or Next.js app shows a large table.
---

# packmem

packmem keeps records as packed columns that code can still index, loop over, update and query, in a fraction of
the memory. Python (`pip install packmem`), Node, Bun and Deno (`npm install packmem`), WebAssembly for browsers
and Cloudflare Workers (`packmem/wasm`, in the npm package), and Rust (`cargo add packmem --no-default-features`).
Docs: https://hamedmp.github.io/packmem/docs/ (all of it as Markdown: https://hamedmp.github.io/packmem/llms-full.txt).

## When to use it

- A process holds thousands to millions of records in memory: an API's dataset, a cache, training annotations
  read by data-loader workers. The gain is memory; queries on the packed data are also fast.
- A browser receives a large table and shows a window of it.

## When not to

- Fewer than about 300 records: no gain.
- HTTP responses of a few dozen rows, or text-heavy rows: after gzip or Brotli, JSON is as small or smaller. Keep
  JSON there.
- Code that touches every field of every row in a hot loop, or that needs joins and numeric analytics: keep the
  list, or use a dataframe or database.

## Python

```python
import packmem

rows = packmem.load_jsonl("events.jsonl")     # json.loads per line -> load_jsonl
rows = packmem.load_json("records.json")      # json.load of a list of records -> load_json (streamed)
rows = packmem.read_csv("data.csv", infer=True)
rows = packmem.from_cursor(cursor)            # any DB-API cursor
rows = packmem.Table(list_of_dicts)

rows[0]; rows[-5:]; len(rows); rows.append({...}); rows.update(3, status=500); rows.sort(key="ts")
rows.count(status=404); rows.sum("bytes", ua__contains="curl"); rows.group_count("country")
rows.where(delay__gt=60, carrier="UA").rows(limit=50, offset=0)
for r in rows.lazy(): total += r["bytes"]     # fast loops that read a few fields
rows.to_json(); rows.where(carrier="UA").iter_json(limit=50)   # JSON bytes without dicts
rows.save("t.pkm"); rows = packmem.open("t.pkm")              # memory-mapped, read-only
rows = packmem.load_json("annotations.json").share()          # DataLoader workers share one copy
```

Filters: `col=value`, `col__gt`, `col__gte`, `col__lt`, `col__lte`, `col__between=(lo, hi)`, `col__prefix`,
`col__contains`.

## Node

```js
import { loadJsonl, loadJson, parse, Table } from "packmem";

const rows = loadJsonl("events.jsonl");       // not readFileSync + JSON.parse: that spends the memory first
rows.at(0); rows.slice(0, 10); rows.length; rows.push({ ... }); rows.update(3, { status: 500 });
rows.count({ status: 404 }); rows.sum("bytes", { ua: { contains: "curl" } }); rows.groupCount("country");
rows.where({ carrier: "UA", dep_delay: { gt: 60 } }).rows({ offset: 0, limit: 50 });
rows.where({ carrier: "UA" }).jsonStream().pipe(res);                  // Express
return new Response(rows.where({ carrier: "UA" }).jsonWebStream());    // fetch-style servers
```

`rows[i]` does not work: use `rows.at(i)`. A `Table` is not an `Array`.

## Server to browser

```js
// server
import { respond, send } from "packmem/http";
export const GET = (request) => respond(request, table.where({ carrier: "UA" })); // Next.js, Workers
app.get("/api/rows", (req, res) => send(req, res, table));                       // Express

// React (0.3.2+): fetches bytes or JSON and opens them with packmem/wasm, loaded once per page
import { useTable, useRows } from "packmem/react";
const { table, error, loading, ms } = useTable("/api/rows");
const visible = useRows(table, { offset, limit: 20 });   // objects only for the rows on screen

// without React
import { init } from "packmem/wasm";
import { fetchTable } from "packmem/http";
const pm = await init("/packmem.wasm");      // serve node_modules/packmem/wasm-dist/packmem_bg.wasm here
const t = await fetchTable(pm, "/api/rows");
```

`respond` and `send` gzip bytes over 1 KB inside the payload for clients that ask (`fetchTable` and `useTable` do);
when a proxy in front compresses already, turn it off with `respond(req, rows, {}, { gzip: false })` or
`send(req, res, rows, 200, { gzip: false })`. `send` returns a Promise.

## Rules

- Next.js: add `serverExternalPackages: ["packmem"]` to `next.config.ts`. Route handlers that use packmem need
  the Node.js runtime, not Edge.
- Use the same packmem version on the server and the client, or a newer one on the client. A reader refuses bytes
  written by a newer packmem ("written by a newer packmem (format N, this build reads up to M)"); from 0.3.1,
  `fetchTable` then asks again for JSON, so the page keeps working without the gain from bytes.
- `fetchTable` asks for bytes and accepts JSON; servers using `respond` or `send` send JSON to clients that do not
  ask for bytes. Keep small endpoints on JSON.
- With TanStack Query, set `structuralSharing: false` for queries that return a packmem `Table`.
- Tables saved with Python's `hint="compact"` cannot be read by `packmem/wasm`.
- `sort`, `insert`, and deletes in the middle rebuild the table: batch them.
- A returned row is a copy: change the table with `rows[i] = ...` / `update` (Python) or `set` / `update` (Node).
