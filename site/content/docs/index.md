# Overview

packmem keeps a collection of records (a Python list of dicts, a JavaScript array of objects) as packed columns.
Your code still indexes it, loops over it, appends to it and updates it, and filters and aggregates run on the
packed data without unpacking it. It is a Rust library with packages for Python, Node and WebAssembly.

```python
rows = [json.loads(line) for line in open("events.jsonl")]   # before
rows = packmem.load_jsonl("events.jsonl")                    # after
```

On 336,776 flight records (nycflights13, 104 MB of JSON lines), the Python list of dicts takes 712 MB and the
packmem table 20 MB, measured on an Apple M4 Pro
([benchmarks/results](https://github.com/HamedMP/packmem/tree/main/benchmarks/results)). Every number on this
site comes from a results file in the repository.

## What you get

- **A container, not a dataframe.** `len`, indexing, slicing, iteration, `append`, `update`, `sort`, `insert`,
  `pop`: the operations of a list. Rows come back as plain dicts or objects.
- **Queries on the packed data.** `count`, `sum`, `group_count` / `groupCount` and `where` with equality, ranges,
  prefixes and substrings.
- **JSON written from the columns.** API responses are produced without building an object per record.
- **Sharing.** Python tables can be saved and memory-mapped (`save` and `open`) or shared with worker processes
  (`share`); Node tables can be shared with worker threads.
- **Bytes you can send.** `to_bytes` / `toBytes` write the packed table; a browser running `packmem/wasm` opens
  them without parsing JSON. `packmem/http` and `packmem/react` wire that into servers and React components.

## When to use it

- A server or worker holds a large collection of records in memory: an API's dataset, a cache, training
  annotations read by data-loader workers. Memory is the main gain.
- Many processes or threads read the same records.
- A browser receives a large table and shows a window of it: it can open packed bytes and build objects only for
  the rows on screen.

## When not to use it

- **Small collections.** packmem breaks even with a Python list at about 300 records; the large ratios start
  around 100,000.
- **Small HTTP responses.** After Brotli, packmem bytes are larger than JSON for tables of a few dozen rows, and
  for text-heavy data such as chat logs. Keep JSON for those; `packmem/http` sends JSON to any client that does
  not ask for bytes.
- **Touching every field of every row.** Plain iteration rebuilds a dict or object per record and is slower than
  looping over the original list (about 5 times in Python). Lazy rows (`rows.lazy()`) and column queries close
  most of that gap.
- **Analytics on columns.** For joins and heavy numeric work, use a dataframe or a database. packmem replaces the
  list of records, not polars or DuckDB.
- **Sorting or inserting in the middle often.** Those rebuild the table, so each costs time proportional to its
  size.

The [README](https://github.com/HamedMP/packmem#where-it-loses) lists every case where packmem loses, with the
measurements.

## How it works

Each field becomes a column. A sampling selector picks a lightweight encoding per chunk of 16,384 rows (frame of
reference, dictionaries, run-length, FSST for strings, and others), and filters run on the encoded form. New
rows go to an uncompressed tail that is packed when it fills. Lists of records inside a record, such as the turns
of a conversation, are stored as their own columns.

## Next

- [Install](/docs/install/) for your language.
- [Quickstart](/docs/quickstart/): load, query and serve records.
- [For coding agents](/docs/agents/): a brief and a skill file to give your agent.
