# The archive hint on nested agent-log rows

`hint="archive"` against `hint="compact"` and zstd -19, on 200,000 synthetic rows shaped like Codex rollouts:
`payload.item` nested up to 7 levels with a shape that varies by event type, and `output` a string in some rows and a
list in others. `nested_gen.py` writes them, with a fixed seed and no real transcript content.

```sh
python nested_gen.py data.jsonl 200000                  # 272.9 MB, 200,000 rows
python run.py data.jsonl results/compact.json compact <commit>
python run.py data.jsonl results/archive.json archive <commit>
python run.py data.jsonl results/zstd19.json zstd19
```

Each arm ran in its own process inside a `systemd-run --user --scope -p MemoryMax=16G -p MemorySwapMax=0` at
`nice -n 10`, on a shared Linux server (AMD Ryzen 9 7950X3D, Python 3.12), commit 4f6f5ec, at a load average of
2 to 3 (per run in the result files). The packmem arms load with `threads=1, keep_key_order=True`, which is how an
archive uses the table. In both, all 200,000 rows re-serialise to their input line byte for byte.

| | size | build | one random row (median) | full scan | peak memory |
| --- | --- | --- | --- | --- | --- |
| JSONL | 272.9 MB | | | | |
| `hint="compact"` | 77.7 MB | 13.0 s | 6.3 µs | 1.28 s | 226 MB |
| `hint="archive"` | 53.3 MB | 54.6 s | 58.8 µs | 1.19 s | 183 MB |
| zstd -19 of the whole file | 48.8 MB | 95.8 s | decompress the file | | 419 MB |

The archive hint is 31% smaller than compact and reads any row in place, without decompressing the rest. It costs
4.2 times the build time and about 9 times the time per random row. zstd -19 on the whole file is 8.5% smaller still,
but reading one row means decompressing the file. Most of the gain on this data comes from keeping nested values as
JSON text instead of splitting them into sub-columns; `python/tests/test_paths.py::test_archive_hint_is_smaller_and_reads_the_same`
pins it.

On about 0.5 GB of one person's real Claude Code and Codex history (measured on a Mac because the transcripts stay
private, so not reproducible here), archive came to about 215 MB, against about 280 MB for compact and about 158 MB
for zstd -19 per file.
