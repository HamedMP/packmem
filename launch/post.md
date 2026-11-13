# Most of the memory behind a list of records is not the records

*Draft for the packmem launch post. Every number links to the results file it comes from (see `SOURCES.md`); the
losses are in the post on purpose.*

---

Load 336,776 flight records from a 104 MB JSON-lines file into a Python list of dicts and the process holds 712 MB.
Load them into packmem and it holds 19.7 MB, and your code still indexes them, loops over them, appends to them and
filters them. The change is one line:

```python
rows = [json.loads(line) for line in open("flights.jsonl")]   # 712 MB
rows = packmem.load_jsonl("flights.jsonl")                    # 19.7 MB
```

packmem is alpha (0.1.0), open source (Apache-2.0), on PyPI and npm (`pip install packmem`, `npm install packmem`), with a Rust
core. This post is about why that 36x is possible, where it holds, and where it does not.

## Where the memory goes

We loaded the same 75.5 MB web log into five runtimes, one record per object, and classified a 64 MB sample of each
heap, word by word. Python grew it to 441 MB, Java to 675 MB. In Python 77% of the words were zeros, pointers and small
integers: object headers, references, hash slots, padding. Bookkeeping, not data. Node was the exception: its heap
was 62% text and 1% small integers, which is why packmem saves less there.

The operating system can compress those pages (zram, zswap, the macOS compressor), but a compressed page has to be
decompressed before any byte in it is read. The larger saving is not to create the overhead at all.

## Pack the columns, query them packed

packmem stores each field as one column and picks an encoding for it from a sample of its values: a dictionary for
`carrier` (16 distinct values, 4 bits a row), the offset from the column minimum for `distance`, run-length for long
runs, FSST for text. Every encoding keeps fast access to a single value, so nothing is ever unpacked in bulk, and
filters run on the packed form.

None of these encodings is new; analytical databases use them (BtrBlocks, Vortex, FSST). What packmem adds is putting
them behind the containers programs already use: a list of dicts, an array of objects.

Because filters and aggregates run on the encoded columns, they also got faster. On the flights, against a loop over
the list of dicts:

| Query | List of dicts | packmem |
| --- | --- | --- |
| Group by destination | 59 ms | 0.14 ms |
| Sum a column | 53 ms | 0.13 ms |
| Count delays over 60 minutes | 39 ms | 0.43 ms |
| Sum with a filter | 33 ms | 1.3 ms |

## Inside a web server

A common shape: load a dataset at start-up, serve filtered pages, aggregates and exports from memory. We built the
same five routes in Express, Next.js and FastAPI and switched the storage with one environment variable. Every
response was identical between the two.

| Settled memory of the whole server | Plain objects | packmem |
| --- | --- | --- |
| FastAPI | 731 MB | 72 MB |
| Express | 390 MB | 94 MB |
| Next.js | 411 MB | 118 MB |

Peak memory while serving was 3.6 to 5.3 times lower in Node and 8.5 to 15 times lower in FastAPI, loaded from the
file or from Postgres. JSON responses are written
straight from the columns and streamed, so an export never builds a full-size string.

In Node the gain is mainly memory: V8 already stores objects of one shape compactly, so the saving at rest is 1.8 to
4.1 times, smaller than Python's. Speed is level to ahead: filtered pages and group-by were faster, single exports
within a few percent either way.

## Two tools, one line changed

| Tool and task | Peak memory | Time |
| --- | --- | --- |
| jello, query 104 MB of JSON lines | 1,535 MB → 381 MB | 2.54 s → 0.57 s |
| sqlite-utils, insert a 104 MB JSON array | 604 MB → 67 MB | 4.85 s → 5.46 s |

The second row is slower: a one-line swap can cost time.

## Against dataframes

packmem is not a dataframe; it replaces the list of dicts. But the comparison matters. polars with inferred types
held the flights in 170 MB (8.6x more than packmem). Tuned for memory (enum strings, the smallest integer types, its
allocator told to return freed memory) polars comes within 1.6 to 2.9 times on the Mac, and needs the schema set by
hand. polars also loads 6 times faster, its filters are 2 to 4 times faster at millions of rows, and pandas was about
3 times faster on a numeric range filter over the flights (0.13 ms against 0.43 ms).

## Where it loses

- **Plain loops over every row are slower.** Each record is rebuilt as a dict on demand: 4.9x slower than the list
  in Python. `rows.lazy()` yields rows that read a field only when it is touched, which beat the list on a one-field
  loop on the Mac (24 ms against 31 ms; level on Linux); rewriting the loop as a query fixes it entirely.
- **Random access to whole rows is slower:** 6.7x for 10,000 random rows.
- **Group-by over very many distinct values is slow:** 436 thousand distinct IPs over 2 million rows took 311 ms,
  against 10 to 62 ms in polars.
- **Sort, insert and delete rebuild the whole table,** so each takes time proportional to its size.
- **Records dominated by a nested list of dicts** load slower than `json.load` and save less.
- **A one-line swap can cost time:** sqlite-utils inserting a 104 MB JSON array took 5.46 s against 4.85 s.
- **Small tables gain nothing.** At 100 rows packmem used more memory than the list; from 300 rows on it used less.
- **Unchanged programs gain nothing.** You have to swap the container.

## On Linux

The same scripts on a Linux server (Ryzen 9 7950X3D): the flights take 12.0 MB against 710 MB (59x). About 8 MB of
packmem's Mac figure (19.7 against 12.0) is load buffers the macOS allocator keeps; glibc returns them. Node saves less
on Linux, lazy rows only match the list there (31 ms against 31 ms), and the Python loop and random-access costs are
wider (5.6x and 9.0x).

## Try it

```sh
pip install packmem      # Python 3.10+, a list of dicts
npm install packmem      # Node 20+, an array of objects; packmem/wasm for Cloudflare Workers
```

The full write-up, every benchmark script and every results file are in the repository:
https://github.com/HamedMP/packmem. The numbers on https://hamedmp.github.io/packmem/ are rebuilt from those files.

*Mac figures: Apple M4 Pro, macOS, medians of fresh processes, measured on a machine in normal use (load average
3 to 10, recorded per run). Linux figures: a dedicated server, load average around 1. The heap study: a 2-core x86
Linux sandbox, on a synthetic web log.*
