# Python

`packmem.Table` is a mutable sequence of dicts stored as packed columns. It replaces a list of records; most code
that reads and writes the list keeps working.

```sh
pip install packmem
```

## Load

| Before | After |
| --- | --- |
| `[json.loads(l) for l in f]` | `packmem.load_jsonl(path_or_lines)` |
| `json.load(f)` for a list of records | `packmem.load_json(path_or_file)` (streamed) |
| `list(csv.DictReader(f))` | `packmem.read_csv(path)` (`infer=True` for numbers) |
| `[dict(zip(names, r)) for r in cursor]` | `packmem.from_cursor(cursor)` (any DB-API cursor) |
| `list(queryset.values())` (Django) | `packmem.from_queryset(queryset)` |
| `pq.read_table(path).to_pylist()` | `packmem.read_parquet(path, columns=[...])` (needs pyarrow) |
| `arrow_table.to_pylist()` | `packmem.from_arrow(table)` (needs pyarrow) |
| any iterable of dicts | `packmem.Table(records)` or `packmem.from_records(records)` |

`load_jsonl` and `load_json` take `fields=[...]` to keep only those top-level keys. Every loader takes
`hint=` (below). `Table`, `from_records`, `from_cursor`, `from_queryset`, `from_arrow` and `read_parquet` take
`default=`, called for values JSON has no form for (dates, decimals, UUIDs) as with `json.dumps(default=...)`;
`default=str` stores them as text.

## Use it as a list

```python
len(rows); rows[0]; rows[-5:]; rows[3] = {...}
rows.append({...}); rows.extend(more); rows.insert(0, {...})
rows.pop(); del rows[10:20]; rows.clear(); rows.reverse()
rows.sort(key="bytes")                 # a column name, or a function of a record; reverse=True
rows.update(3, status=500)             # change fields of one record in place
rows.set_column("source", "a.jsonl")   # one value for every record, or one value per record
rows.take([3, 1, 2]); rows.copy(); rows.shuffle()
for r in rows: ...                     # dicts
```

A returned row is a fresh dict: changing it does not change the table. Use `rows[i] = ...` or
`rows.update(i, ...)`. `sort`, `del`, `pop`, `reverse` and `insert` anywhere but the end rebuild the table.

## Query the packed data

```python
rows.count(status=404)
rows.sum("bytes", agent__contains="curl")
rows.group_count("country", path__prefix="/api/")

v = rows.where(dep_delay__gt=60, carrier="UA")   # a View: matching row numbers
len(v); v.sum("distance"); v.group_count("dest"); v.column("dest")
v.rows(limit=10, offset=0)                       # a page of dicts
v.indices()                                      # the row numbers
```

Filters: `col=value`, `col__prefix`, `col__contains`, `col__gt`, `col__gte`, `col__lt`, `col__lte`,
`col__between=(lo, hi)`. Every condition must hold.

## Loops that read a few fields

```python
for r in rows.lazy():
    total += r["bytes"]      # decodes only the fields you read
    r["seen"] = True         # writes to the table
```

A lazy row is a mapping, not a dict; `r.to_dict()` gives a dict.

## JSON without dicts

```python
rows.to_json()                                       # bytes: one JSON array
rows.where(carrier="UA").to_json(limit=50, offset=100)
for chunk in rows.iter_json(batch=4096): ...         # for streaming responses
```

In FastAPI:

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import packmem

app = FastAPI()
rows = packmem.load_jsonl("flights.jsonl")

@app.get("/flights")
def flights(carrier: str, limit: int = 50, offset: int = 0):
    return StreamingResponse(rows.where(carrier=carrier).iter_json(limit=limit, offset=offset),
                             media_type="application/json")
```

## Lists of records inside a record

A field that holds a list of records, such as the turns of a conversation, is stored as its own columns. Compute
per-record figures without a Python loop; the names follow pandas:

```python
turns = rows.col("conversations")
turns.list.len()                                              # turns per record
turns.list.field("value").str.len().list.sum()                # characters per record
turns.list.field("value").str.split().list.len().list.sum()   # words per record
rows.col("image").notna()                                     # which records have the key
```

Each returns one value per record as a list, with `.to_numpy()` and `.to_arrow()` when those libraries are
installed.

## Save, open and share

```python
rows.save("events.pkm")
rows = packmem.open("events.pkm")      # memory-mapped, read in place, read-only

rows = packmem.load_json("annotations.json").share()   # worker processes read one shared copy
```

- `open` takes milliseconds whatever the size; pages are read as they are touched and shared by every process
  that opens the file. `copy()` gives a private, writable table.
- `share(dir=None)` writes the table to a file (in `/dev/shm` on Linux) and makes it read-only, so pickling it to
  a `DataLoader` or `multiprocessing` worker sends only the file's location. `unshare()` makes it writable again.
  `packmem.cleanup_stale()` removes files left by a crashed process.
- `to_bytes()` and `Table.from_bytes(data)` give the same packed form as bytes, for sending or storing. See
  [Byte format](/docs/format/).

## Arrow and Parquet

With pyarrow installed:

```python
rows = packmem.read_parquet("events.parquet", columns=["status", "bytes"])
rows = packmem.from_arrow(arrow_table)   # a table, a record batch or an iterable of batches
rows.to_arrow()                          # a pyarrow.Table, for polars, pandas or DuckDB
rows.to_parquet("events.parquet")
```

These copy the data. Arrow cannot say a key is absent, so absent keys become nulls, and a column holding more than
one type raises `TypeError` in `to_arrow()`.

## Hints

`hint=` chooses what the encodings favour: `"balanced"` (default), `"memory"`, `"speed"`, or `"compact"`.
`"compact"` also compresses long text (documents, conversation turns) with Zstandard in small blocks that share a
dictionary trained on the column: smaller for prose, slower to load and to read. A table saved with `"compact"`
cannot be opened by the WebAssembly build.

## Inspect

```python
rows.columns       # column names
rows.nbytes        # approximate bytes held
rows.describe()    # (column, encodings, bytes) per column
```

## Threads

Filters, group counts and sums run on several threads once a table has 16 chunks (about 260,000 rows), and
`load_jsonl`, `load_json` and `read_csv` on a file of 8 MB or more load on up to four threads. Answers are the
same as with one thread. `PACKMEM_THREADS=1` turns this off; `PACKMEM_THREADS=n` sets the number of threads
(default: the cores, at most 8).

## Semantics

- Values round-trip exactly: ints (including beyond 64 bits), floats (including NaN), bools, None, strings,
  nested lists and dicts. Tuples come back as lists.
- Key order in returned dicts is the order columns were first seen.
- `sum` adds ints, floats and bools and skips everything else.
- Nested values are written by `to_json()` in a canonical form: the same values, not necessarily the same text as
  the source.
- A table pickles as its packed columns; a shared or opened table pickles as its file's location.

The full list is in [python/README.md](https://github.com/HamedMP/packmem/blob/main/python/README.md).
