# Where every number in the launch drafts comes from

| Claim | File |
| --- | --- |
| 712 MB list vs 19.7 MB packmem, 170 MB polars, load times, query timings, loop 4.9x and random rows 6.7x slower, lazy 24 vs 31 ms | `benchmarks/results/mac-m4pro/datasets.jsonl` (medians, load average 3.7 to 5.2) |
| Heap composition: Python 441 MB and 77% bookkeeping, Java 675 MB | `experiments/results/heap_results.jsonl` (2-core Linux sandbox, synthetic log) |
| Tuned polars 1.6 to 2.9x (Mac) | `benchmarks/results/mac-m4pro/polars_tuned.jsonl`, `polars_tuned_decay0.jsonl` |
| 311 ms vs 10 to 62 ms high-cardinality group-by | `benchmarks/results/mac-m4pro/logs_2m.jsonl`, `polars_tuned.jsonl` |
| Break-even between 100 and 300 rows | `benchmarks/results/mac-m4pro/crossover_flights.jsonl` |
| jello and sqlite-utils, before and after | `benchmarks/results/mac-m4pro/apps.jsonl` (medians of three) |
| Web servers, settled and peak memory, identical responses | `demos/bench/results/darwin-arm64.json`, `darwin-arm64-postgres.json` |
| Linux: 710 vs 12.0 MB, loop 5.6x, random 9.0x | `benchmarks/results/linux-x86-fast-ci-dev/datasets.jsonl` |
| Workers: 200,000 rows in 0.69 MB | `demos/workers` under `wrangler dev` (not a recorded results file; say "in a local wrangler run") |

Labels to keep wherever a number is quoted: Mac runs were on a machine in normal use; Linux tuned-polars figures are
memory only, measured under CI load; the Linux Postgres server rows are an upper bound (measured before V8 returned
its pooled pages).
