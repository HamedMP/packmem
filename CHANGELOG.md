# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- Python: `hint="archive"`, for tables written once and read now and then. As `compact`, with text compressed at
  Zstandard level 19, long values sharing blocks of up to 256 KB, and nested values kept as text instead of split
  into sub-columns. Smaller, several times slower to build, and reading one row decodes larger blocks. The byte
  format is unchanged: released versions read such a table, and it reopens as `compact`. On 200,000 generated
  agent-log rows with deep nested values (272.9 MB of JSON lines, Linux, one thread, `keep_key_order=True`):
  53.3 MB against 77.7 MB for `compact` and 48.8 MB for zstd -19 of the whole file; 54.6 s to build against
  13.0 s; 58.8 µs to read one random row against 6.3 µs; a full scan takes the same 1.2 to 1.3 s, and every row
  reproduces its line (`benchmarks/archive_hint/`).

## 0.3.4 - 2026-11-16

### Added
- Python: `keep_key_order=True` on `Table`, `load_jsonl` and `load_json` remembers the order of each row's keys,
  so a row reads back with its keys as they were written instead of in the table's column order. With it,
  `json.dumps(row, separators=(",", ":"), ensure_ascii=False)` reproduces a line that `json.dumps` wrote. The
  order is kept through `append`, `extend`, item assignment, `insert`, `sort`, `take`, `to_json`, `save`,
  `share` and pickling; a key added later with `update` comes last. Columns and queries are unaffected. It costs
  a few bits a row while rows share a handful of orders, more when nearly every row has its own. A table that
  keeps key orders is written as byte format 6, which 0.3.3 and earlier refuse with "written by a newer
  packmem"; every other table is still written as format 5. The Node and WebAssembly builds do not read
  format 6 yet and refuse it the same way.
- Node: `npx packmem archive` keeps Claude Code and Codex transcripts, compressed, after the agents delete
  them. Each long string is stored once across sessions, and a session counts as archived only after it
  restores byte for byte; every read checks it again. It never deletes or changes the agents' own files,
  writes only into a new, empty or existing archive folder, and `delete --all` removes only the files it wrote.
  Subcommands: `--dry-run`, `status`, `list`, `verify`, `restore`, `stats`, `delete`. Files are private to the
  user (0600/0700). It uses zstd on Node 22.15 and newer, Brotli before that. On a synthetic 358 MB set the
  archive is 38.0 MB, against 69.4 MB for zstd -19 on each file, and building it on Linux peaks at 444 MB of
  memory (`node/bench/results/agent-history-archive.json`, `agent-history-archive-peak.json`).
  On one person's history of about 1.0 GB, measured on a Mac because the transcripts stay private, it is about
  210 MB against about 240 MB for zstd -19 on each file, and building it peaked at about 1.2 GB of memory; a later run on about 0.9 GB of the same history peaked at
  about 0.96 GB. Part of that is freed memory that macOS keeps counted
  (`node/bench/results/agent-history-own-history.json`). Docs: `/docs/agent-history/`.

## 0.3.3 - 2026-11-15

### Fixed
- Python on Linux: loading a large file on several threads no longer leaves each thread's freed buffers in the
  peak. `load_json` on the 1.03 GB LLaVA-665k file, peak anonymous memory at 1 / 2 / 4 threads: 372 / 479 / 613
  MiB in 0.3.2, 376 / 384 / 442 MiB now. The load takes 6.42 / 2.19 / 1.48 s in 0.3.2 and 6.39 / 2.38 / 1.54 s
  now, so two threads are 9% slower and four 4%; a threaded load holds 6 to 29 MiB less afterwards
  (`benchmarks/ml_swaps/linux-node/results/0.3.2/load_threads/`). With
  eight trainer ranks loading that file at once, the Qwen3-VL node peak at 20,000 samples per rank goes from
  5.77 GiB in 0.3.2 to 4.47 GiB, below the 4.86 GiB of 0.1.0; the full-shard and MiniCPM-V peaks, which come
  from iteration, barely move (6.21 to 6.12 and 7.31 to 7.25 GiB;
  `benchmarks/ml_swaps/linux-node/results/4bf9c3e-8x4/`). Three changes: load threads give large buffers their
  own mapping, which returns to the system when freed, where glibc kept them in per-thread arenas; a thread
  drops buffers over 16 MiB between pieces; and the mapped input is released behind each thread as it parses,
  which takes peak file-backed memory at four threads from 261 to 146 MiB. Dropping a whole table built this
  way takes about 3 ms longer on 665,000 rows.

### Added
- Python: `load_json`, `load_jsonl` and `read_csv` take `threads=`. A file of 8 MB or more is parsed on up to
  four threads by default, and each thread holds a chunk of rows unpacked while it works, so the load is faster
  and its peak memory higher than on one thread. `threads=1` gives the one-thread load and the lowest peak
  without turning off threaded queries (which `PACKMEM_THREADS=1` also does); up to 8 can be asked for. The table
  is the same, byte for byte, at any count.
- Benchmarks: `benchmarks/browser/` measures JSON against packmem bytes in headless Chromium on five datasets,
  uncompressed, Brotli-compressed and at 20 Mbit/s, with packmem 0.3.0. Every run is in
  `benchmarks/browser/results/runs.jsonl`. From 10,000 rows, tables are usable 2.6 to 7.6 times sooner on
  loopback and hold 1.3 to 2.4 times less memory. Below about 1,000 rows JSON is faster and smaller, and after
  Brotli the conversation and issue datasets (long text) are 1 to 10% larger as packmem bytes at every size.
  Turning every row into an object takes 2 to 3 times as long as `JSON.parse`.
- Benchmarks: `benchmarks/wire-size/` breaks down where the bytes go and compares what 0.3.0 writes with JSON
  (`benchmarks/wire-size/results/sizes-0.3.0.jsonl`).
- Benchmarks: `benchmarks/apps/lightdash/` runs Lightdash 3.261.1's own query-results endpoint with a 25-line
  patch, at 100,000 rows. Against gzipped JSON at the 2,500-row page cap, packmem in one response holds 7.4 times
  less memory in the browser (15.5 against 115.3 MB) and sends 1.26 times fewer bytes (3.25 against 4.09 MB). Time
  until usable is only 1.16 times shorter (11.8 against 13.7 s), because the server's own row formatting
  dominates. At the same 2,500-row pages packmem is no faster and needs 1.2 s more server time.
- Benchmarks: the 8-rank Linux run (8 torchrun ranks, 4 fork workers each, the real LLaVA-665k file) is re-run
  on 0.3.2 (`benchmarks/ml_swaps/linux-node/results/0.3.2-8x4/`). Node PSS peak at 20,000 samples per rank,
  median of 3: Qwen3-VL 47.81 to 5.77 GiB, MiniCPM-V 37.82 to 7.31 GiB; full shard 54.88 to 6.21 GiB (one run).
  Batches are identical on all 8 ranks. At 20,000 samples the packmem peak is above what 0.1.0 measured (4.86
  and 7.13 GiB): 0.3.x parses `load_json` on four threads, and with 8 ranks loading at once that transient now
  sets the peak. `threads=1` on the loader avoids it at the cost of load time.
- Benchmarks: one rank, a full shuffled epoch, 4 workers, on 0.3.2: fork 10.24 to 1.05 GiB, spawn 15.32 to
  2.68 GiB (`benchmarks/ml_swaps/linux-node/RESULT-0.3.2.md`).
- Benchmarks: paperless-ngx `document_exporter` at 100,000 documents on 0.3.2: peak RSS 1,191 MiB with the list
  against 664 (JSON round trip), 660 (`default=`) and 580 MiB (`hint="compact"`), output byte-identical. At
  20,000 documents packmem still peaks 15 to 39 MiB above the list
  (`benchmarks/apps/paperless-ngx/RESULT-0.3.2.md`).

### Changed
- Demos: `demos/log-viewer` depends on packmem ^0.3.2 from npm, so it deploys without a Rust toolchain. Its
  README figures are re-measured on 0.3.2 at 1,000,000 rows: 31.7 MB of gzipped packmem bytes against 32.7 MB of
  gzipped JSON (`demos/log-viewer/results/check-0.3.2.txt`).

## 0.3.2 - 2026-11-15

### Added
- Node: `packmem/react` adds `useTable(url, options?)`, returning `{ table, error, loading, ms }`. It fetches a
  table as packmem bytes, or JSON from servers without packmem, and opens it with `packmem/wasm`, which it loads
  once per page. It refetches when the URL changes and drops stale responses. On the server it renders the
  loading state, so it works where Next.js loads packmem outside its bundle. The `.wasm` file is found through
  `new URL(..., import.meta.url)`, which Next.js, Vite and webpack serve without setup.
- Demos: `demos/log-viewer`, a Next.js app that sends 1,000,000 generated log records to the browser with
  `useTable` and `useRows`, next to the same rows loaded as JSON.

### Changed
- Node: `respond` and `send` from `packmem/http` gzip bytes over 1 KB inside the payload when the client's Accept
  asks for `application/vnd.packmem; enc=gzip`, and mark the response with that media type. `fetchTable` asks for
  it and unzips with `DecompressionStream`. Hosts compress only the types they know: Next.js gzips JSON but not
  packmem bytes, and drops a route's own Content-Encoding. `{ gzip: false }` turns it off. `send` now returns a
  Promise. Clients on 0.3.x do not ask for gzip, so they keep getting plain bytes. Measured on main 90602dc
  against gzipped JSON (`benchmarks/browser/results/tables-gzip-main-90602dc.md`): flights is 29 to 52% smaller
  from 100 rows; traces, logs and issues are 2 to 23% smaller from 1,000 to 10,000 rows on; conversations are 0 to
  5% larger at every size, and every dataset is 11 to 52% larger at 10 rows.

## 0.3.1 - 2026-11-14

This version writes byte format 5, which 0.3.0 cannot read: upgrade readers before, or together with, writers.

### Fixed
- A column of records with none absent (`{"k": 1}` in every row) stored four bytes a row of offsets that said
  nothing, in memory and in the byte form. On a 16,500-row table with one such column, 0.3.0 wrote 126,641 bytes
  where 0.2.0 wrote 61,388; this version writes 60,641 (`python/tests/fixtures/`). The offsets are now a row
  count. This raises the byte format version to 5: files from 0.2.0 and 0.3.0 still open, and 0.3.0 refuses
  files from this version with "written by a newer packmem".
- Node: `fetchTable` from `packmem/http` asks again for JSON when the server sends bytes from a newer packmem
  than the reader. This holds from this version on: a browser on 0.3.0 talking to a newer server still reports
  the "newer packmem" error. Give the browser the same packmem version as the server, or a newer one.

## 0.3.0 - 2026-11-14

Checked against 0.2.0 on Linux with the Qwen3-VL and LLaVA-NeXT dataset builds
(`benchmarks/ml_swaps/sub-columns-gate/`): peak memory during the build is 6 to 7% lower and memory afterwards
6 to 14% lower. On one thread (`PACKMEM_THREADS=1`) building the table takes 4 to 8% longer than 0.2.0, and the
per-record length passes those trainers run next take 25 to 34% less; with the default threads the build is 1.4
to 4 times faster.

### Added
- Columns whose values are lists of records (the turns of a conversation), or single records, are stored as
  sub-columns: one offset per row and one packed column per field, the layout Arrow uses for a list of structs.
  Rows read back as before, without parsing JSON.
- Python: `Table.col(name)` with pandas-style operations computed on the packed data: `notna()`, `isna()`,
  `.list.len()`, and for lists of records `.list.field(name).str.len().list.sum()` and
  `.str.split().list.len().list.sum()` (word counts as `str.split()` gives them).
  `.list.field(name).to_list()` reads only that field's sub-column.

- Python: `hint="compact"` compresses long text with Zstandard in blocks of about 1 KB with a trained dictionary
  of 256 KB, shared by the chunks of a column and written once. `PACKMEM_ZSTD_DICT_KB`, `PACKMEM_ZSTD_BLOCK`
  and `PACKMEM_ZSTD_LEVEL` tune it. Native builds only; a table saved this way cannot be opened by the
  WebAssembly build.
- Python: `Table(records, default=...)`, `extend(rows, default=...)` and `append(row, default=...)` convert values
  JSON has no form for (dates, decimals, UUIDs), at any depth, as `json.dumps(default=...)` does.
- Python: `Table.to_arrow()`, `Table.to_parquet()`, `packmem.from_arrow()` and `packmem.read_parquet()`, using
  pyarrow when it is installed. They copy the data; absent keys become nulls in Arrow. Columns of numbers,
  booleans and text are written straight into Arrow buffers. After a load, pyarrow's allocator is asked to give back
  the pages of the batches it has freed, which it otherwise keeps counted against the process.
- Node and WebAssembly: `Table#toBytes()` and `Table.fromBytes(bytes)`. They use the byte form Python's `to_bytes`
  writes, so a table packed by a Python or Node server can be sent to a browser running `packmem/wasm` and read
  without re-encoding. `toBytes` also works on a table shared with worker threads.
- Node: `packmem/http` sends tables to browsers. `respond(request, rows)` (web `Response`) and
  `send(req, res, rows)` (Node and Express) return packmem bytes when the client sends
  `Accept: application/vnd.packmem`, and a streamed JSON array otherwise, with `Vary: Accept`.
  `fetchTable(pm, url)` asks for bytes and falls back to JSON; it works as an SWR or TanStack Query fetcher. Also
  exports `wantsPackmem` and `PACKMEM_TYPE`. It has no Node imports, so it runs in Node, Next.js route handlers,
  Workers and browsers.
- Node: `packmem/react` adds `useRows(rows, { offset, limit })`. It returns plain objects for the visible window
  only, and the same array until the window or the table changes. It imports nothing from React, so it also works
  when Next.js loads packmem outside its bundle (`serverExternalPackages`).
- Demos: `/api/flights/export` in the Express, Next.js and FastAPI demos answers
  `Accept: application/vnd.packmem` with the packed rows. The Next.js demo has a `/browse` page that opens them
  with `packmem/wasm` and scrolls them with `useRows`.

### Changed
- Nested values are split into sub-columns as rows arrive, not when a chunk is packed, so a load no longer holds
  each chunk's nested values twice. A chunk whose nested values turn out not to be uniform keeps them as text in
  canonical form.
- Filters, group counts over a whole column, and sums of decimal columns run on several threads once a table has
  16 chunks (about 260,000 rows). Answers are the same as with one thread. `PACKMEM_THREADS` sets the number of
  threads (default: the cores, at most 8; 1 turns it off). The WebAssembly build stays single-threaded.
- Python: `load_jsonl`, `load_json` and `read_csv` on a file of 8 MB or more parse and pack on up to four threads and give the
  same table as a one-thread load. The file is read through a memory mapping, whose pages are released as each
  part is loaded. More memory is in use while the
  load runs (each thread holds one chunk of unpacked rows); it is given back when the load ends.
  `PACKMEM_THREADS=1` restores the one-thread load. Loads from file objects are unchanged.
- Python on macOS: buffers of 32 KB or more that the library frees go straight back to the system. macOS
  otherwise keeps counting freed memory against the process, which left a load's working buffers in its
  footprint for good.
- `to_json()` writes nested values stored as sub-columns in a canonical form (as `json.dumps` would), not as
  they were written in the source. Values are unchanged.
- The byte form (`to_bytes`, `save`, `share`, pickles) now starts with a format version, 4 in this release. Files
  from 0.2.0 still open. 0.2.0 cannot read files written by this version and says so. From this version on, a file
  written by a newer packmem is refused with "written by a newer packmem" instead of a parse error.
- Byte form: single integers in the headers (counts, lengths, chunk metadata) are now LEB128 varints, signed ones
  zigzagged, which makes small tables smaller; large tables barely change. Vectors and floats stay at full width
  and padded, so mapped files still read in place.
- Measured, not changed: after Brotli, packmem bytes are still larger than JSON for tables of a few dozen rows
  and for text-heavy data. Keep JSON for small responses; `packmem/http` falls back to it for clients that do not
  ask for bytes.
- Node: nested values stored as sub-columns come back in canonical form from `toJson` and `jsonBuffer`, as in
  Python. They stay the same values. Escapes in strings are rewritten as `JSON.stringify` writes them; number text
  and key order are kept as written. This replaces the 0.2.0 Node note about keeping nested JSON as written.

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
