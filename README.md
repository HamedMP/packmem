# packmem

[![packmem: 712 MB as a Python list of dicts, 19.7 MB in packmem](https://hamedmp.github.io/packmem/og.png)](https://hamedmp.github.io/packmem/)

[![PyPI](https://img.shields.io/pypi/v/packmem?label=PyPI&cacheSeconds=3600)](https://pypi.org/project/packmem/)
[![npm](https://img.shields.io/npm/v/packmem?label=npm&cacheSeconds=3600)](https://www.npmjs.com/package/packmem)
[![crates.io](https://img.shields.io/crates/v/packmem?label=crates.io&cacheSeconds=3600)](https://crates.io/crates/packmem)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)](https://pypi.org/project/packmem/)
[![CI](https://github.com/HamedMP/packmem/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/HamedMP/packmem/actions/workflows/ci.yml)
[![Node CI](https://github.com/HamedMP/packmem/actions/workflows/node.yml/badge.svg?branch=main)](https://github.com/HamedMP/packmem/actions/workflows/node.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A list of records that takes a fraction of the memory and can still be filtered, aggregated,
appended to and updated, without being unpacked.

```python
rows = [json.loads(line) for line in open("events.jsonl")]   # before: 712 MB
rows = packmem.load_jsonl("events.jsonl")                    # after:   20 MB
```

Charts and the project story: https://hamedmp.github.io/packmem/

packmem stores each field of a record collection as a column, picks a lightweight encoding for
it from a sample of the data, and runs filters and aggregates on the encoded form. It is a Rust
library with Python and Node packages on top. Status: **alpha** (0.2.0).

## Results

336,776 real flight records (nycflights13, 104 MB as JSON lines) on an Apple M4 Pro, median of
five fresh processes at load average 4 to 5. Lower is better everywhere. pandas and polars are run with default
settings (inferred types); tuning their column types for memory would narrow the gap.

| Holder | Resident MB | Load s | Count by carrier ms | Group by dest ms | Loop over rows ms |
| --- | --- | --- | --- | --- | --- |
| List of dicts | 712 | 0.61 | 30 | 59 | 31 |
| packmem | 20 | 0.25 | 0.57 | 0.14 | 153 (24 with lazy rows) |
| pandas, Arrow-backed | 215 | 0.09 | 1.4 | 2.1 | 2,600 |
| polars | 170 | 0.04 | 2.4 | 3.3 | 282 |

On Linux (Ryzen 9 7950X3D, Ubuntu 24.04, load average about 1) the same data gives 710 MB for
the list and 12 MB for packmem: glibc returns the memory used while loading, which macOS keeps.
There, lazy rows match the list's loop speed (31 ms each) instead of beating it, plain iteration
is 5.6 times slower and random row access 9 times slower.

### Against polars tuned for memory

The table above uses polars with inferred types. With every string column cast to an enum, the
smallest integer types, a rechunk, and its allocator told to return freed memory
(`_RJEM_MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0`), polars gets much closer:

| Dataset | List of dicts | polars, default | polars, tuned | packmem |
| --- | --- | --- | --- | --- |
| Flights, 337 thousand rows | 712 MB | 166 MB | 41 to 57 MB | 19 MB |
| Synthetic web log, 2 million rows | 3,053 MB | 764 MB | 256 to 271 MB | 98 MB |
| Flights repeated 10 times, 3.4 million rows | 7,101 MB | 1,203 MB | 175 to 198 MB | 113 MB |

So packmem holds 1.6 to 2.9 times less than tuned polars, and tuned polars needs the schema to be
known and set by hand. On Linux the gap is wider, because packmem's own resident size is lower there: 12 MB against
47 to 71 MB on the flight data, 76 against 245 to 276 MB on the log, and 94 against 185 to 209 MB
on the flights repeated 10 times (2.0 to 6.0 times; memory only, measured under CI load).

In return polars loads 4 to 5 times faster from JSON lines and far faster
from parquet, and its filters are 2 to 4 times faster at millions of rows. These runs were taken
on a busy machine; the memory figures are stable, the timings are not final.

One line changed in two existing tools, outputs identical:

| Tool and task | Time | Peak memory |
| --- | --- | --- |
| sqlite-utils 4.2.1, insert a 104 MB JSON array | 4.85 s to 5.46 s | 604 MB to 67 MB |
| jello 1.6.1, query 104 MB of JSON lines | 2.54 s to 0.57 s | 1,535 MB to 381 MB |

### In training-data pipelines

Three vision-language fine-tuning repositories (Qwen3-VL, MiniCPM-V, LLaVA-NeXT) keep their
annotations as a list of dicts that every data-loader worker touches. Swapping it for packmem on
the real 665,298-record LLaVA mix took one 8-rank node with 4 fork workers per rank from 47.7 GiB
to 4.9 GiB on Linux, and a 4-worker epoch on the Mac from 16.6 GB to 2.3 GB under fork and
23.5 GB to 5.5 GB under spawn. Building the dataset is 2 to 4 times slower, because the nested
conversation turns are stored as JSON text. These figures cover the annotations only (no images,
model or GPU) and none of the repositories has tests covering the patched code. Patches, scripts
and outputs are in [benchmarks/ml_swaps](benchmarks/ml_swaps); the Linux runs' raw traces were lost
and only their summaries remain.

### Against Hugging Face datasets

With `save()` and `open()` (0.2.0), a packmem table is memory-mapped like a `datasets` Arrow
cache, and on Linux it now uses less memory. Measured on the published packages (packmem 0.2.0,
datasets 5.2.0) with a 4-worker PyTorch DataLoader over the 665,298-record LLaVA mix, forkserver
workers, medians of 3 runs
([benchmarks/ml_swaps/hf-datasets/pypi-0.2.0](benchmarks/ml_swaps/hf-datasets/pypi-0.2.0/RESULT_0.2.0.md)):

| | Whole machine (PSS) | Above a loader with no data | Parent process | First batch |
| --- | --- | --- | --- | --- |
| List of dicts | 15,961 MB | +15,099 MB | 3,810 MB | 63.5 s |
| `datasets`, memory-mapped Arrow | 1,810 MB | +243 MB | 379 MB | 1.8 s |
| packmem `share()` | 1,148 MB | +10 MB | 249 MB | 1.1 s |
| packmem `open()` of a saved table | 1,144 MB | +5 MB | 245 MB | 1.0 s |

With fork workers the whole machine held 549 MB with `open()` against 994 MB with `datasets` and
3,604 MB with a list. Every variant produced identical batches.

Most of `datasets`' +243 MB is not data: each worker imports the library it reads with, and
importing `datasets` adds 55.5 MB of private memory to a process against 0.2 MB for packmem.
The data itself is memory-mapped by both and shared by every process; what differs is the
file, 309 MB for packmem's saved table against 785 MB for the Arrow cache, and how much of it a
worker touches (176 MB against 407 MB for the same rows). `share()` keeps its file in
`/dev/shm`, which is RAM: 1,182 MB if the whole file is counted.

These cover the annotations only (no images, model or GPU). Memory held to within about 1 MB
across runs; the server's load was 10 to 27, so the timings are indicative. The same comparison
on a Mac with spawn workers ([demos/finetune-loader](demos/finetune-loader)) gives 3 MB above
an empty loader for `open()` against 228 MB for `datasets` and 4.0 GB for a list.

- **Where packmem is ahead:** less memory per machine, a file 2.5 times smaller than the Arrow
  cache, a random row as a dict in 6 µs against 22 µs (the path a map-style loader uses), and
  it takes the JSON file as it is, where `datasets` needed a hand-written schema.
- **Where `datasets` is ahead:** batched and columnar access is about twice as fast, and a
  compressed parquet file is smaller at rest.

The per-row and batched figures are from the earlier Linux run with packmem 0.1.1
([benchmarks/ml_swaps/hf-datasets](benchmarks/ml_swaps/hf-datasets)).

### Where it loses

- **Plain iteration is slower.** `for r in rows` rebuilds a dict per record and is about 5 times
  slower than looping over the original list. `rows.lazy()` closes the gap but yields mappings,
  not dicts.
- **Random row access** is about 7 times slower than indexing a list (8.7 ms against 1.3 ms for
  10,000 rows).
- **Dataframes load faster** and win some numeric filters. packmem is not a dataframe; it
  replaces the list of dicts.
- **Group-by on a column with very many distinct values is slow.** Counting 436 thousand
  distinct IP addresses over 2 million rows takes about 310 ms, against 11 ms in polars (and
  590 ms for a dict loop over the list).
- **Records dominated by a nested list of dicts load slowly.** Nested values are stored as JSON
  text, so such datasets build 2 to 4 times slower than `json.load` and save less.
- **Small collections gain little.** packmem breaks even with the list at about 300 records
  and saves 2 to 4 times at 10,000; the large ratios start around 100,000. Memory used while
  loading stays with the allocator, which is most of what a small table occupies.
- **Sort, delete and insert in the middle rebuild the table,** so each costs time proportional
  to its size.

The full study, including the cases above and the method, is in [docs/report.md](docs/report.md).

## Install

```
pip install packmem          # Python 3.10 or later; wheels for Linux, macOS and Windows
npm install packmem          # Node, Bun and Deno, see node/README.md
cargo add packmem --no-default-features   # Rust, without the benchmark's C dependencies
```

From a checkout, with Rust:

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

rows.save("events.pkm")                          # from 0.2.0: reopen in milliseconds, read in place
rows = packmem.open("events.pkm")
rows.share()                                     # worker processes read one shared copy
```

With pyarrow installed, tables convert both ways (unreleased, on `main`):

```python
rows = packmem.read_parquet("events.parquet", columns=["status", "bytes"])
rows = packmem.from_arrow(arrow_table)           # or a record batch, or an iterable of batches
rows.to_arrow()                                  # a pyarrow.Table, for polars, pandas or DuckDB
rows.to_parquet("events.parquet")
```

These copy the data. Arrow has no way to say a key is absent, so absent keys become nulls
on the way out, and a column holding more than one type has to be converted before `to_arrow()`.

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
