# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
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
