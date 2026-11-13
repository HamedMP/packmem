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
| `json.load(f)` for a list of records | `packmem.load_json(f)` (path or file, streamed) |
| `list(csv.DictReader(f))` | `packmem.read_csv(path)` or `packmem.Table(csv.DictReader(f))` |
| `[dict(r) for r in cursor]` | `packmem.Table(cursor)` |
| `[dict(zip(names, r)) for r in cursor]` | `packmem.from_cursor(cursor)` (any DB-API cursor) |
| any iterable of dicts | `packmem.Table(records)` |

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
- `load_jsonl` and `load_json` accept what `json.loads` accepts, including `NaN`, `Infinity` and strings
  with lone surrogate escapes.
- Pickling the flight table gives 8 MB in 3 ms and loads in 1 ms (46 MB, 125 ms and 163 ms for the list).
- A table can be pickled (as its packed columns, with no re-encoding on load), so it can be handed to `multiprocessing` and `DataLoader` workers started with
  spawn. Each worker then holds its own copy; under fork the packed data is shared.
- `rows.shuffle()` and `rows.take(indices)` rebuild once. `random.shuffle(rows)` works but is far slower.

Status: alpha. Requires Python 3.10 or later. Built and tested on Linux x86-64 and macOS arm64; the CI workflow has not run yet.
