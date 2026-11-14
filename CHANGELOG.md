# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- Columns whose values are lists of records (the turns of a conversation), or single records, are stored as
  sub-columns: one offset per row and one packed column per field, the layout Arrow uses for a list of structs.
  Rows read back as before, without parsing JSON.
- Python: `Table.col(name)` with pandas-style operations computed on the packed data: `notna()`, `isna()`,
  `.list.len()`, and for lists of records `.list.field(name).str.len().list.sum()` and
  `.str.split().list.len().list.sum()` (word counts as `str.split()` gives them).

- Python: `hint="compact"` compresses long text with Zstandard in small blocks with a trained dictionary. Native
  builds only; a table saved this way cannot be opened by the WebAssembly build.
- Python: `Table.to_arrow()`, `packmem.from_arrow()` and `packmem.read_parquet()`, using pyarrow when it is
  installed. They copy through Python values; absent keys become nulls in Arrow.

### Changed
- `to_json()` writes nested values stored as sub-columns in a canonical form (as `json.dumps` would), not as
  they were written in the source. Values are unchanged.
- Files written by this version that contain sub-columns cannot be read by 0.2.0. Files from 0.2.0 still open.

## 0.2.0 - 2026-11-14

The byte form changes in this release: pickles, shared files and `to_bytes` output from 0.1.x cannot be read
by 0.2.0, and the reverse.

### Added
- Python: `Table.save(path)` and `packmem.open(path)`: a saved table is memory-mapped and read in place, so opening takes
  milliseconds whatever its size and costs the process almost no memory of its own.
- Python: tables shared with `share()` are read in place by the processes that receive them, and by the process
  that shared them: the data exists once, in the file's pages, instead of once per worker.
- Python: `Table.__getitems__` fetches a batch of records in one call (PyTorch's DataLoader uses it when present).
- Node: `Table#share()`, `Table.fromShared(handle)` and `unshare()` let worker threads read one table without a
  copy (threads, not processes).
- Node: `PACKMEM_LOAD_THREADS=1` for the file loaders (native builds only).

### Changed
- The byte form written by `to_bytes`, pickling and `share()` has a new layout (arrays are aligned so they can be
  read in place). Data written by 0.1.x cannot be read by this version, and the reverse.
- Node: nested JSON values are kept as written, as in Python since 0.1.2; `toJson` and `jsonBuffer` bytes can
  differ from earlier versions on escaped input while parsing to the same values.
- Python: on Windows, `save` over a file that is open anywhere fails with an explanation; close the tables that
  have it open first.

## 0.1.2 - 2026-11-14

### Changed
- Python: nested JSON values are kept as written instead of being parsed and re-serialised, which makes records
  dominated by nested text faster to load and smaller once loaded. Rows read back equal, but text
  inside a nested value is no longer normalised: `\uXXXX` escapes in the source stay escapes, so `to_json()`
  can differ byte for byte from 0.1.1 on such input (1.6% longer on one real dataset) while parsing to the
  same values.
- Python: `PACKMEM_LOAD_THREADS=1` packs text-heavy chunks on a background thread, about halving the load time of such
  data. It is off by default because it leaves more memory counted against the process on macOS.

### Added
- `fields=` on `load_json` and `load_jsonl` keeps only the named keys; the rest are skipped while parsing.
- `Table.share()` writes the packed table to a file once, so pickling it for worker processes sends only
  a pointer; `unshare()`, the `shared` property and `packmem.cleanup_stale()`.

## 0.1.1 - 2026-11-13

### Added
- `Table.set_column` sets a field on every record in one pass.
- `read_csv` parses UTF-8 files natively and takes `infer=True` for typed columns.
- `from_queryset` packs a Django queryset without model instances or dicts.
- `default=` on `from_cursor` and `from_queryset` converts dates, decimals, UUIDs and bytes.
- The core crate's LZ4 and Zstandard dependencies are behind a default-on `baselines` feature, so
  bindings and WebAssembly builds carry no C code.
- Node: `sort`, `splice`, `push`, `pop`, `shift`, `unshift`, `reverse` and lazy rows (`table.lazy()`).
- Node: `loadCsv`, `loadTsv` and `parseCsv` on the core CSV loader.
- Node: `fromPgCopy` loads Postgres through `COPY` with no row objects; `fromQuery` takes Drizzle and Kysely queries.
- Node: `packmem/wasm`, a WebAssembly build for Cloudflare Workers and other runtimes without native addons.
- Node: prebuilt addons for musl (Alpine) and Intel Macs; Linux glibc builds now need glibc 2.17 instead of 2.34.
- Node releases are built, tested on every platform and published with provenance from CI.

### Changed
- Serialising a table (`to_bytes`, pickling) writes once into the output buffer.

### Fixed
- Subclasses of `Table` keep their type and attributes through pickling and `from_bytes`.
- Tests no longer depend on the platform's default text encoding; CI runs on Windows.
- Integer columns with a long tail of distinct values (token ids) no longer get a dictionary that is larger than
  plain storage.

## 0.1.0 - 2026-11-13

First release. Alpha: the API and the `to_bytes` format may change between versions.

### Added
- Rust core: integer encodings (constant, frame of reference, sorted dictionary, run-length,
  block frame of reference), string encodings (dictionary, FSST), a sampling selector with
  `Memory`, `Balanced` and `Speed` hints, and operators that run on the encoded form.
- `DynTable`: a mutable, schema-flexible table with append, update, nulls, floats, nested values
  and columns whose type changes over time.
- Python package: `Table`, `load_jsonl`, `load_json`, `read_csv`, `from_records`, filters,
  `sum`, `group_count`, lazy rows through `Table.lazy()`, and the list methods `sort`, `insert`,
  `pop`, `reverse`, `clear` and `del`.
- JSON output straight from the columns: `to_json` and `iter_json` on tables and filtered views,
  and `offset` for paging through `View.rows`.
- Benchmark against polars tuned for memory, with recorded results.
- Tables can be pickled; `take`, `copy`, `shuffle` and a native `extend(Table)`; `Table` is registered as a
  `MutableSequence`.
- Strings with lone surrogate escapes load and round-trip instead of being rejected.
- `from_cursor` packs the rows of any DB-API cursor without building a dict per row.
- Benchmarks on nycflights13 and nginx logs, one-line swaps in sqlite-utils and jello, and
  recorded results for Linux x86-64 and macOS arm64.
