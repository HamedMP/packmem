# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- Rust core: integer encodings (constant, frame of reference, sorted dictionary, run-length,
  block frame of reference), string encodings (dictionary, FSST), a sampling selector with
  `Memory`, `Balanced` and `Speed` hints, and operators that run on the encoded form.
- `DynTable`: a mutable, schema-flexible table with append, update, nulls, floats, nested values
  and columns whose type changes over time.
- Python package: `Table`, `load_jsonl`, `load_json`, `read_csv`, `from_records`, filters,
  `sum`, `group_count`, lazy rows through `Table.lazy()`, and the list methods `sort`, `insert`,
  `pop`, `reverse`, `clear` and `del`.
- Benchmarks on nycflights13 and nginx logs, one-line swaps in sqlite-utils and jello, and
  recorded results for Linux x86-64 and macOS arm64.
