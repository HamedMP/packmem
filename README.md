# packmem

A list of records that takes a fraction of the memory and can still be filtered, aggregated,
appended to and updated, without being unpacked.

```python
rows = [json.loads(line) for line in open("events.jsonl")]   # before: 712 MB
rows = packmem.load_jsonl("events.jsonl")                    # after:   21 MB
```

packmem stores each field of a record collection as a column, picks a lightweight encoding for
it from a sample of the data, and runs filters and aggregates on the encoded form. It is a Rust
library with a Python package on top. Status: **alpha**.

## Results

336,776 real flight records (nycflights13, 104 MB as JSON lines) on an Apple M4 Pro, median of
five fresh processes. Lower is better everywhere.

| Holder | Resident MB | Load s | Count by carrier ms | Group by dest ms | Loop over rows ms |
| --- | --- | --- | --- | --- | --- |
| List of dicts | 712 | 0.63 | 31 | 59 | 41 |
| packmem | 21 | 0.26 | 0.60 | 0.20 | 155 (25 with lazy rows) |
| pandas, Arrow-backed | 215 | 0.09 | 1.4 | 2.4 | 2,650 |
| polars | 167 | 0.04 | 2.8 | 3.4 | 285 |

One line changed in two existing tools, outputs identical:

| Tool and task | Time | Peak memory |
| --- | --- | --- |
| sqlite-utils 4.2.1, insert a 104 MB JSON array | 4.85 s to 5.46 s | 604 MB to 67 MB |
| jello 1.6.1, query 104 MB of JSON lines | 2.54 s to 0.57 s | 1,535 MB to 381 MB |

### Where it loses

- **Plain iteration is slower.** `for r in rows` rebuilds a dict per record and is about 4 times
  slower than looping over the original list. `rows.lazy()` closes the gap but yields mappings,
  not dicts.
- **Random row access** is about 2.5 times slower than indexing a list.
- **Dataframes load faster** and win some numeric filters. packmem is not a dataframe; it
  replaces the list of dicts.
- **Small collections gain little.** packmem breaks even with the list at about 300 records
  and saves 2 to 4 times at 10,000; the large ratios start around 100,000. Memory used while
  loading stays with the allocator, which is most of what a small table occupies.
- **Sort, delete and insert in the middle rebuild the table,** so each costs time proportional
  to its size.

The full study, including the cases above and the method, is in [docs/report.md](docs/report.md).

## Install

Not on PyPI yet. From a checkout, with Rust and Python 3.10 or later:

```
cd python
pip install maturin
maturin build --release -o dist
pip install dist/*.whl
```

## Use

```python
import packmem

rows = packmem.load_jsonl("events.jsonl")        # or load_json, read_csv, Table(iterable_of_dicts)

len(rows); rows[0]; rows[-5:]                    # still a sequence of dicts
rows.append({"status": 200, "bytes": 512})
rows.update(3, status=500)
rows.sort(key="bytes", reverse=True)            # also insert, pop, del, reverse

rows.count(status=404)                           # runs on the packed data
rows.sum("bytes", agent__contains="curl")
rows.group_count("country", path__prefix="/api/")

for r in rows.lazy():                            # decode only the fields you read
    total += r["bytes"]
```

See [python/README.md](python/README.md) for the full API and its semantics.

The Rust crate exposes the same building blocks:

```rust
use packmem::{Hint, PackedInts, PackedStrs};

let latency = PackedInts::encode(&values, Hint::Balanced);
latency.get(42);
latency.sum();
latency.count_range(1_000, 5_000);

let agents = PackedStrs::encode(&strings, Hint::Balanced);
agents.count_where(|s| s.starts_with(b"curl"));
```

## How it works

- **A small set of encodings that compose:** constant, frame of reference, sorted dictionary,
  run-length, block frame of reference, string dictionary and FSST. Every one keeps O(1) or
  O(log n) access to a single value.
- **A sampling selector** estimates the size of each encoding from 64 runs of 256 values and
  picks one, weighted by a hint (`memory`, `balanced` or `speed`).
- **Predicates are pushed into the encoding.** A string filter over a dictionary column tests
  each distinct value once and then scans small integer codes.
- **Writes** go to an uncompressed tail that is packed every 16,384 rows; updates to packed rows
  go to a small patch map.

The encodings are established work from analytical databases (BtrBlocks, Vortex, FSST). What
packmem adds is putting them behind an ordinary container API for program memory.

## Reproduce the numbers

```
python -m venv .venv && .venv/bin/pip install maturin pandas polars pyarrow nycflights13
(cd python && ../.venv/bin/maturin build --release -o dist && ../.venv/bin/pip install dist/*.whl)
mkdir data && (cd data && ../.venv/bin/python ../benchmarks/fetch_data.py)
.venv/bin/python benchmarks/run_all.py data results.jsonl 5
```

Recorded results, with machine details, are in [benchmarks/results](benchmarks/results). The
synthetic-log study behind the report is in [experiments](experiments).

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Rust core: integer and string encodings, the selector, the mutable table |
| `python/` | Python package (PyO3, built with maturin) and its tests |
| `benchmarks/` | Real-data benchmarks, tool-swap runs and recorded results |
| `experiments/` | Synthetic-log study: generator, cross-runtime workloads, recorded results |
| `docs/` | The technical report |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Copyright 2026 Finna Labs Inc.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in
this project by you, as defined in the Apache-2.0 license, shall be licensed as above, without any
additional terms or conditions.
