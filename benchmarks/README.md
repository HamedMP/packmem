# Real-data benchmarks

| File | Purpose |
| --- | --- |
| `fetch_data.py` | Builds the inputs: nycflights13 as JSON lines, JSON, CSV and SQLite, plus Elastic's nginx sample log |
| `bench.py` | One holder (list, packmem, pandas, polars) on one dataset, in one process: memory, load time, queries |
| `bench_io.py` | `csv.DictReader` and `sqlite3` swaps |
| `run_all.py` | Runs every variant in fresh processes several times and writes median, minimum and maximum |
| `apps.sh`, `runapp.py` | sqlite-utils and jello, original against one line patched |
| `bench_polars_tuned.py`, `run_polars_tuned.py` | polars with enum and narrow integer types, a known schema, parquet, and its allocator set to return freed memory |
| `crossover.py` | Memory and load time against the list for 100 to 1,000,000 rows |
| `mem.py` | Resident memory, physical footprint and peak on Linux and macOS |

Memory on macOS is the physical footprint, which counts compressed pages; on Linux it is
resident set size. Results are in `results/<machine>/`, each with the machine line that
`run_all.py` records. `linux-x86-sandbox` predates the optimisation pass described in the report and was run in a
2-core sandbox; `linux-x86-server` is the current build on a dedicated machine.
