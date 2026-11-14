# Quickstart

Each section loads records, queries them on the packed data, and writes JSON or bytes. Pick your language.

## Python

```sh
pip install packmem
```

```python
import packmem

rows = packmem.load_jsonl("events.jsonl")   # or load_json, read_csv, Table(iterable_of_dicts)

len(rows); rows[0]; rows[-5:]               # still a sequence of dicts
rows.append({"status": 200, "bytes": 512})
rows.update(3, status=500)

rows.count(status=404)                      # runs on the packed data
rows.sum("bytes", agent__contains="curl")
rows.group_count("country", path__prefix="/api/")
rows.where(status=404).rows(limit=10)       # a page of matching dicts

rows.to_json()                              # one JSON array, written from the columns
rows.save("events.pkm")                     # reopen with packmem.open, memory-mapped
```

More in [Python](/docs/python/).

## Node

```sh
npm install packmem
```

```js
import { loadJsonl } from "packmem";

const rows = loadJsonl("events.jsonl");     // or loadJson, loadCsv, parse(text), new Table(records)

rows.length; rows.at(0); rows.slice(0, 10); // plain objects
rows.push({ status: 200, bytes: 512 });
rows.update(3, { status: 500 });

rows.count({ status: 404 });
rows.sum("bytes", { agent: { contains: "curl" } });
rows.groupCount("country", { path: { prefix: "/api/" } });
rows.where({ status: 404 }).rows({ limit: 10 });

rows.jsonBuffer();                          // JSON array bytes, written from the columns
```

More in [Node](/docs/node/).

## A server and a browser

The server answers with packed bytes when the client asks for them, and JSON otherwise. The browser opens the
bytes with WebAssembly and builds objects only for the rows it shows.

```js
// server (Express); in a Next.js route handler use respond(request, rows) instead
import express from "express";
import { loadJsonl } from "packmem";
import { send } from "packmem/http";

const flights = loadJsonl("flights.jsonl");
const app = express();
app.get("/api/flights", (req, res) => send(req, res, flights.where({ carrier: "UA" })));
app.listen(3000);
```

```js
// browser
import { init } from "packmem/wasm";
import { fetchTable } from "packmem/http";

const pm = await init("/packmem.wasm");     // serve node_modules/packmem/wasm-dist/packmem_bg.wasm at this path
const table = await fetchTable(pm, "/api/flights");
table.length;
table.slice(0, 20);                         // objects for 20 rows only
```

In React, `useTable` does the loading and fetching, and `useRows` builds objects for a window of rows:

```tsx
import { useRows, useTable } from "packmem/react"

const { table } = useTable("/api/flights")              // the .wasm file is served by Next.js, Vite or webpack
const rows = useRows(table, { offset: 0, limit: 20 })
```

Use the same packmem version in the server and the browser. More in [packmem/http](/docs/http/),
[packmem/react](/docs/react/) and the [Next.js guide](/docs/nextjs/).

## Rust

```sh
cargo add packmem --no-default-features
```

```rust
use packmem::{Hint, PackedInts, PackedStrs};

let latency = PackedInts::encode(&values, Hint::Balanced);
latency.get(42);
latency.sum();
latency.count_range(1_000, 5_000);

let agents = PackedStrs::encode(&strings, Hint::Balanced);
agents.count_where(|s| s.starts_with(b"curl"));
```

More in [Rust](/docs/rust/).
