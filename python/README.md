# packmem

A list of dicts that takes a fraction of the memory. Records are stored as packed columns
that you can still index, iterate, append to and update, and that can be filtered and
aggregated without unpacking.

```python
rows = [json.loads(line) for line in open("events.jsonl")]   # before
rows = packmem.load_jsonl("events.jsonl")                    # after
```

`rows` keeps working as a sequence of dicts:

```python
len(rows); rows[0]; rows[-5:]; rows.append({...}); rows.extend(more)
rows.insert(0, {...}); rows.pop(); del rows[10:20]; rows.reverse()
rows.sort(key="bytes")         # a column name, or a function of a record as in list.sort
rows.take([3, 1, 2]); rows.copy(); rows.shuffle(); pickle.dumps(rows)
rows.set_column("source", "a.jsonl")       # one value, or one value per record
rows[3] = {...}                 # replace a record
rows.update(3, status=500)      # change fields in place
for r in rows: ...
```

and gains queries that run on the packed data:

```python
rows.count(status=404)
rows.sum("bytes", agent__contains="curl")
rows.group_count("country", path__prefix="/api/")
rows.where(delay__gt=60, carrier="UA").rows(limit=10)
```

Loops that read a few fields per record are fastest over lazy rows, which decode a field only
when it is read and write back on assignment:

```python
for r in rows.lazy():
    total += r["bytes"]          # about as fast as looping over the original list
    r["seen"] = True             # writes to the table
```

A lazy row is a mapping, not a `dict`; use `r.to_dict()` where a real dict is required.

Records can be written as JSON straight from the columns, without building a dict per record:

```python
rows.to_json()                                   # bytes holding one JSON array
rows.where(carrier="UA").to_json(limit=50, offset=100)
for chunk in rows.iter_json(batch=4096): ...     # for streaming responses
```

On the flight data `rows.to_json()` takes 0.24 s against 0.43 s for `json.dumps` on the original list.
Values always read back equal; a few floats are written with a different, equally short, last digit
than `json.dumps` would choose.

Filters: `col=value`, `col__prefix`, `col__contains`, `col__gt`, `col__gte`, `col__lt`,
`col__lte`, `col__between=(lo, hi)`.

## One-line swaps

| Before | After |
| --- | --- |
| `[json.loads(l) for l in f]` | `packmem.load_jsonl(f)` (path or file) |
| `json.load(f)` for a list of records | `packmem.load_json(f)` (path or file, streamed; `fields=[...]` keeps only those keys) |
| `list(csv.DictReader(f))` | `packmem.read_csv(path)` (add `infer=True` for numbers instead of strings) or `packmem.Table(csv.DictReader(f))` |
| `[dict(r) for r in cursor]` | `packmem.Table(cursor)` |
| `[dict(zip(names, r)) for r in cursor]` | `packmem.from_cursor(cursor)` (any DB-API cursor) |
| `list(queryset.values())` (Django) | `packmem.from_queryset(queryset)` |
| any iterable of dicts | `packmem.Table(records)` |

## In a web service

Hold the data once at start-up and answer from the packed columns. Responses are written as JSON
straight from the columns, so no dict is built per record:

```python
from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse
import packmem

app = FastAPI()
rows = packmem.load_jsonl("flights.jsonl")

@app.get("/flights")
def flights(carrier: str, limit: int = Query(50, ge=0, le=1000), offset: int = Query(0, ge=0)):
    view = rows.where(carrier=carrier)
    return StreamingResponse(view.iter_json(limit=limit, offset=offset), media_type="application/json")

@app.get("/destinations")
def destinations(carrier: str):
    return rows.group_count("dest", carrier=carrier)
```

From a database, rows go into columns without model instances or dicts. `default=` converts
values that are not JSON-like, such as dates and decimals:

```python
orders = packmem.from_queryset(Order.objects.filter(year=2026), default=str)                 # Django
orders = packmem.from_cursor(conn.execute("select id, customer, total from orders"))        # any DB-API cursor
orders.sum("total", customer="acme")
```

## With worker processes

A table pickles as its packed columns, which is cheap, but a worker started with spawn still receives
and holds a copy. `share()` writes the table once to a file and makes it read-only; pickling it then
sends only the file's location, and each worker loads from the file:

```python
rows = packmem.load_json("annotations.json").share()
loader = DataLoader(MyDataset(rows), num_workers=4, multiprocessing_context="spawn")
```

Workers read the file in place, so they share one copy of the data and hold almost none of their own.
On a 2-million-row table with four spawned workers, each worker's memory went from 298 MB to 21 MB,
which is the interpreter itself, and the parent's from +132 MB to no increase. In a Qwen3-VL fine-tuning data loader on 665,298 real
records (4 spawn workers, annotations only), parent plus workers peaked at 4.5 GB with plain pickling
and 2.7 GB with `share()`, and the first batch arrived in 1.2 s instead of 4.1 s. A shared table refuses changes (`copy()` gives a private,
writable one; `unshare()` makes the original writable again and removes the file). The file is readable only by
its owner and is removed when the table is unshared or garbage-collected, and `packmem.cleanup_stale()` clears files left by a
crashed process. The file is the size of the packed table and goes to `/dev/shm` on Linux (memory) and to the temp
directory elsewhere (disk, on macOS and Windows); pass `share(dir=...)` to choose.

## Lists of records inside a record

A field that holds a list of small records, such as the turns of a conversation, is stored as its own packed
columns, so rows are rebuilt without parsing JSON and per-record figures can be computed without a Python loop:

```python
turns = rows.col("conversations")
turns.list.len()                                              # turns per record
turns.list.field("value").str.split().list.len().list.sum()   # words per record, as str.split() counts them
turns.list.field("value").str.len().list.sum()                # characters per record
rows.col("image").notna()                                     # which records have the key
```

The names follow pandas (`notna`, `.str`, `.list`). Each returns one value per record as a list, with
`.to_numpy()` and `.to_arrow()` when those libraries are installed.

## Long text

`hint="compact"` compresses long text (documents, conversation turns) with Zstandard in small blocks that share a
dictionary trained on the column. Use it when most of a table's size is prose:

```python
rows = packmem.load_json("conversations.json", hint="compact")
```

Everything else behaves the same. The costs: loading is slower, reading a value decodes its block, and filters on
such a column read the text instead of comparing compressed bytes. Short strings and numbers are stored as with
`hint="memory"`. Not available in the WebAssembly build, which refuses to open a table saved this way.

## Saving and reopening

```python
rows.save("events.pkm")
rows = packmem.open("events.pkm")      # milliseconds, whatever the size
```

An opened table is memory-mapped and read in place: a 2-million-row table opened in 5 ms and added under
1 MB to the process. Pages are read from disk as they are touched and shared by every process that opens the
same file. Opened tables are read-only (`copy()` gives a private, writable one), and pickling one sends the
file's location, not the data. The file format belongs to the packmem version that wrote it; do not truncate or
rewrite a file in place while it is open. `save` over an existing file replaces it whole, which Windows refuses
while that file is open anywhere.

## What to expect

Measured on 336,776 real flight records on an Apple M4 Pro (see `benchmarks/` in the repository):

| | List of dicts | packmem |
| --- | --- | --- |
| Resident memory | 712 MB | 20 MB |
| Load from JSON lines | 0.61 s | 0.25 s |
| Filter and aggregate queries | 31 to 59 ms | 0.13 to 1.3 ms |
| Loop reading one field | 31 ms | 24 ms with `rows.lazy()`, 153 ms with plain iteration |
| 10,000 random rows as dicts | 1.3 ms | 8.7 ms |

Plain iteration builds a full dict per record, which is why it is slower than the list it replaces.
Loading from `csv.DictReader` or a database cursor is 1.2 to 1.5 times slower than building the list.

## Semantics to know

- Values round-trip exactly: ints, floats (including NaN), bools, None, strings, nested lists
  and dicts, integers beyond 64 bits. Tuples come back as lists.
- A returned row is a fresh dict; mutating it does not change the table. Use `rows[i] = ...`
  or `rows.update(i, ...)`.
- Key order in returned dicts is the order columns were first seen.
- `sum` adds ints, floats and bools and skips everything else. Integers beyond 64 bits are
  stored exactly but are not treated as numbers by filters or `sum`.
- `sort`, `del`, `pop`, `reverse` and `insert` anywhere but the end rebuild the table, so each takes time
  proportional to its size. Row numbers held by a `View` or a lazy row refer to positions, not records.
- Nested values (lists and dicts inside a record) are stored as JSON text and parsed when read. Their text is kept
  as written, so escapes and number formatting inside them are preserved rather than normalised.
- Setting `PACKMEM_LOAD_THREADS=1` packs text-heavy chunks on a background thread while parsing continues, which
  roughly halves the load time of records dominated by long text. It is off by default: the result is identical,
  but more memory stays counted against the process afterwards on macOS.
- `load_jsonl` and `load_json` accept what `json.loads` accepts, including `NaN`, `Infinity` and strings
  with lone surrogate escapes.
- Pickling the flight table gives 8 MB in 3 ms and loads in 1 ms (46 MB, 125 ms and 163 ms for the list).
- A table can be pickled (as its packed columns, with no re-encoding on load), so it can be handed to `multiprocessing` and `DataLoader` workers started with
  spawn. Each worker then holds its own copy; under fork the packed data is shared.
- `rows.shuffle()` and `rows.take(indices)` rebuild once. `random.shuffle(rows)` works but is far slower.

Status: alpha. `pip install packmem`. Requires Python 3.10 or later. Tested in CI on Linux x86-64, macOS arm64 and
Windows x86-64; the Linux arm64 and musl wheels are cross-built and not exercised by tests.
