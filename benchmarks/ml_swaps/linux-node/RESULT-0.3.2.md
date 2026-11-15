# qwen-vl-finetune and MiniCPM-V on Linux with packmem 0.3.2

Two parts: one rank reading a full shuffled epoch through 4 workers (below), and the 0.1.0 headline
configuration, [8 ranks x 4 fork workers](#8-ranks-x-4-fork-workers-the-010-headline-re-run), re-run with raw files.

**8 ranks x 4 fork workers, 20k samples per rank (median of 3), node-wide PSS peak:** qwen-vl-finetune
**47.81 -> 5.77 GiB** (8.3x lower; 0.1.0: 47.73 -> 4.86 GiB). MiniCPM-V **37.82 -> 7.31 GiB** (5.2x; 0.1.0:
37.89 -> 7.13). Full 1/8 shard per rank, Qwen: **54.88 -> 6.21 GiB** (1 run; 0.1.0: 54.69 -> 6.55). Batches are
bit-identical for all 8 ranks in every run. 0.3.2's packmem peak is higher than 0.1.0's at 20k because of the
threaded `load_json` transient (see below).

## One rank, a full shuffled epoch through 4 workers

**Headline (measured, median of 3 fresh runs each):** qwen-vl-finetune's `LazySupervisedDataset` on the real
LLaVA-1.5 665k annotations. One rank reads one full shuffled epoch (665,298 samples) through 4 DataLoader
workers. Peak memory for the whole job (PSS summed over every process):

| | list (`json.load`) | packmem 0.3.2 | |
| --- | --- | --- | --- |
| 4 **fork** workers, full epoch | **10.24 GiB** | **1.05 GiB** | 9.8x lower |
| 4 **spawn** workers, full epoch | **15.32 GiB** | **2.68 GiB** | 5.7x lower |
| Main process only, no workers, 20k samples | **4.02 GiB** | **1.04 GiB** | 3.9x lower |

Collated `input_ids`, `labels` and `position_ids` are bit-identical between the arms in all 18 runs. All 665,298
records deep-equal `json.load`'s output.

All numbers are host RAM for the annotations plus the Python and torch processes around them. There are no images,
no model and no GPU. GiB = 2^30 bytes. Raw files: [`results/0.3.2/`](results/0.3.2/).

## What changed from the 0.1.0 runs

[`RESULT.md`](RESULT.md) is the 0.1.0 run on the same machine (8 ranks x 4 workers, 20k samples per rank). Its raw
traces were lost, so it cannot be cited with raw files. This re-run:

- uses **packmem 0.3.2 from PyPI** (wheel sha256 `2176dd4a...0e163`);
- runs **one rank** with the full epoch, as on a single-GPU job. (The 8-rank configuration is re-run separately,
  [below](#8-ranks-x-4-fork-workers-the-010-headline-re-run), with a 64 GiB cap.) Per rank, the two runs agree. Spawn, per rank (rank + 4
  workers at the peak): 0.1.0 at 2x4 with 20k samples, 14.85 against 2.41 GiB (6.2x). 0.3.2 at 1x4 with the full
  epoch, 15.17 against 2.52 GiB (6.0x);
- caps every one-rank run with `systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0` and `nice -n 10`, one run at
  a time. Each run waits up to 10 minutes for the 1-minute load to reach 4.

Same as before: the harness (`harness/qwen_rank.py`, `monitor.py`, `qstubs.py`), the stubs, the data, and
`packmem.v2.patch` (+29/-12 in `data_processor.py`). The patch is applied to the same Qwen3-VL commit,
`96588727e44c78b25ba03ea03b8e12f7e64fd0da`, which was still upstream `main` on 2026-11-15. It applied
unchanged, and no packmem API it uses (`load_json`, `Table.lazy`, `Table.take`, `Table.extend`) changed.

## Environment

From [`results/0.3.2/env.txt`](results/0.3.2/env.txt):

| | |
| --- | --- |
| Machine | Shared Linux server: AMD Ryzen 9 7950X3D (16 cores / 32 threads), 124 GiB RAM. It also runs CI. |
| OS | Ubuntu 24.04.5 LTS, Linux 6.8.0-139-generic, glibc 2.39, THP `madvise`, KSM off |
| Python | 3.12.3, venv: torch 2.15.0+cpu, transformers 5.23.0, numpy 2.5.4, pillow 13.0.0, packmem 0.3.2 |
| Data | `llava_v1_5_mix665k.json`, 1,029,887,963 bytes, sha256 `ce959ce6...6cf8`, 665,298 records |
| Runs | 2026-11-15, 13:10 to 14:33 CET |

## Method

As in [`RESULT.md`](RESULT.md#method), with `--shards 1`. One torchrun rank builds the dataset with the repository's
own class and reads a `DistributedSampler(num_replicas=1, shuffle=True, seed=0)` epoch through
`DataLoader(batch_size=4, num_workers=4, prefetch_factor=2)` and the repository's collator. The main-process-only
runs use `num_workers=0` and the first 20,000 indices. `monitor.py` reads `smaps_rollup` of every process under
torchrun every 0.5 s:

- **peak**: the highest sum of PSS over those processes in any sample. That sum is the RAM the job uses, with
  shared pages counted once.
- **steady**: the median of that sum over the second half of the iteration window.

Order, from `harness/seq_qwen032.sh`:
1. the record check and pickle check, 1 run each per arm (`single.sh`);
2. the main-process-only runs, 3 per arm;
3. the fork epoch, 3 runs per arm;
4. the spawn epoch, 3 runs per arm.

Arms are interleaved (list, packmem, list, ...).

## Results

All values in GiB, median (min-max) of 3 runs. From [`results/0.3.2/aggregate_q.md`](results/0.3.2/aggregate_q.md).

| config | arm | node PSS peak | steady | before iteration | rank peak PSS | worker peak PSS / USS | sum of RSS (peak) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fork 1x4, epoch | list | **10.24** (10.24-10.24) | 9.64 | 4.02 | 3.85 | 2.07 / 1.78 | 14.87 |
| fork 1x4, epoch | packmem | **1.05** (1.04-1.05) | 1.01 | 1.00 | 0.82 | 0.17 / 0.08 | 2.92 |
| spawn 1x4, epoch | list | **15.32** (14.89-15.33) | 14.52 | 4.02 | 4.97 | 3.10 / 3.08 | 15.73 |
| spawn 1x4, epoch | packmem | **2.68** (2.55-2.68) | 2.54 | 1.03 | 0.91 | 0.47 / 0.46 | 3.09 |
| main only, 20k | list | **4.02** (4.02-4.02) | 3.08 | 4.02 | 3.85 | - | 4.11 |
| main only, 20k | packmem | **1.04** (1.02-1.04) | 0.70 | 1.04 | 0.86 | - | 1.12 |

Fork workers in the list arm copy the parent's pages as they touch records: each grows to 1.78 GiB of private
memory over the epoch. With packmem they stay at 0.08 GiB. Spawn workers each unpickle their own copy of the dataset:
3.1 GiB for the list, 0.47 GiB for the table.

### Time (indicative: the server also runs CI)

| | list | packmem |
| --- | --- | --- |
| Dataset build (`json.load` / `load_json` + `data_path`) | 4.85 s | 2.50 s (up to 4 threads) |
| Fork epoch, DataLoader pass | 185.5 s (178.6-305.1) | 166.7 s (164.1-335.4) |
| Spawn epoch, DataLoader pass | 223.4 s (220.3-229.9) | 164.9 s (164.2-177.6) |
| Spawn, `iter()` to each worker's first batch (median) | 40.8 s | 5.9 s |
| `pickle.dumps(dataset)`: size / time | 689.8 MB / 6.6 s | 297.4 MB / 0.31 s |
| `pickle.loads` | 2.71 s | 0.27 s |

In the 0.1.0 single-process run on this machine, the build took 13.6-14.1 s with packmem against 7.8 s with the
list, at load about 30. In 0.3.2 the packmem build is faster than `json.load`.

### Load average per run (1/5/15 min, start -> end, and seconds waited for load <= 4)

| run | fork list | fork packmem | spawn list | spawn packmem |
| --- | --- | --- | --- | --- |
| r1 | 3.65 -> 6.48, 0 s | 3.37 -> 6.06, 45 s | 4.49 -> 5.56, 600 s | 3.45 -> 6.77, 30 s |
| r2 | 3.83 -> 9.48, 45 s | 3.63 -> 12.66, 135 s | 3.52 -> 3.64, 45 s | 3.64 -> 4.42, 0 s |
| r3 | **36.91** -> 16.62, 600 s | **28.34** -> 35.67, 600 s | 3.52 -> 6.44, 15 s | 3.87 -> 4.15, 45 s |

CI jobs pushed the load to 28-41 during fork r3. Both arms' r3 hit the 10-minute wait and ran at that load. Their
times (305 s and 335 s) are the maxima in the time table. Their memory matches r1 and r2 to 0.01 GiB. The
main-process-only runs started at loads of 2.0-3.0.

## Correctness

- **Records**: `qwen_single.py verify` writes sha256(`json.dumps(row, sort_keys=True)`) for each of the 665,298
  rows. The two arms' digest files are byte-identical, with combined hash `d566b270f1dd6211...`, the same as in the
  0.1.0 run. The digest files (21 MB each) are not committed; their sha256 is in `env.txt`.
- **Batches**: every collated `input_ids`, `labels` and `position_ids` tensor is hashed in order. Full epoch:
  `74d563e6aa7632d1... / 797b051806e57206... / 5b09be88640cdbfa...` in all 12 epoch runs, fork and spawn, both
  arms. 20k samples: `17a385696aedef5e... / d3337748ed932419... / 0b376123fa03495b...` in all 6 runs.
- **Pickle**: the round trip is equal for both arms.

## 8 ranks x 4 fork workers (the 0.1.0 headline), re-run

The configuration of [`RESULT.md`](RESULT.md), whose raw traces were lost: 8 torchrun ranks, each with 4 fork
workers. Raw files: [`results/0.3.2-8x4/`](results/0.3.2-8x4/). A second copy is kept on the benchmark server in
the folder of benchmark inputs and raw results that its README says must not be deleted.

Same harness, data and upstream commits as 0.1.0:
- **Qwen3-VL:** `96588727e44c`. `harness/qwen_rank.py`, batch 4.
- **MiniCPM-V:** `4dbbb6c58b6f`, `packmem.v2.patch` (+10/-7), `harness/mcpm_rank.py`, batch 8, the same stubs.
  The MiniCPM-format data was regenerated with `harness/convert.py`. Its sha256 `1a59b9b1...00ef` is identical
  to 0.1.0's.

Both upstream commits were still `main` on 2026-11-15. The MiniCPM venv uses the 0.1.0 versions: transformers
4.51.2, deepspeed 0.20.0, peft 0.14.0, accelerate 0.30.1, torchvision 0.29.2+cpu, plus packmem 0.3.2.

**Cap:** the list arm needs about 48-55 GiB, so these runs used `systemd-run --user --scope -p MemoryMax=64G
-p MemorySwapMax=0` and `nice -n 10` (0.1.0 used 70G). Each list run waited for `MemAvailable` >= 80 GiB. It
was 94-113 GiB at every start, so no run waited for memory. Each run also waited up to 10 minutes for load <= 4.
Order: `harness/seq_8x4_032.sh`, arms interleaved, 2026-11-15 18:41-20:33 CET.

### Node-wide PSS, GiB (median (min-max); 0.1.0 from RESULT.md)

| model | samples / rank | arm | 0.1.0 peak | **0.3.2 peak** | 0.1.0 steady | 0.3.2 steady | 0.3.2 before iteration | 0.3.2 per rank at peak | 0.3.2 sum of RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen | 20,000 | list | 47.73 (47.59-47.86) | **47.81** (47.81-47.97) | 46.62 | 46.96 | 30.67 | 5.96 | 116.4 |
| Qwen | 20,000 | packmem | 4.86 (4.85-4.86) | **5.77** (5.57-5.92) | 4.83 | 4.53 | 5.77 | 0.71 | 20.8 |
| Qwen | 83,163 (shard) | list | 54.69 | **54.88** | 52.04 | 52.67 | 30.67 | 6.84 | 117.0 |
| Qwen | 83,163 (shard) | packmem | 6.55 | **6.21** | 6.45 | 6.10 | 5.84 | 0.76 | 21.4 |
| MiniCPM | 20,000 | list | 37.89 (37.85-37.94) | **37.82** (37.81-37.82) | 37.01 | 36.96 | 32.23 | 4.71 | 124.2 |
| MiniCPM | 20,000 | packmem | 7.13 (7.06-7.19) | **7.31** (7.27-7.40) | 6.99 | 7.21 | 6.93 | 0.89 | 26.6 |

The shard rows are 1 run per arm, as in 0.1.0. Full tables:
[`aggregate_q.md`](results/0.3.2-8x4/aggregate_q.md) and [`aggregate_m.md`](results/0.3.2-8x4/aggregate_m.md).

Ratios, list / packmem peak:
- Qwen 20k: 8.3x (0.1.0: 9.8x).
- Qwen shard: 8.8x (0.1.0: 8.4x).
- MiniCPM 20k: 5.2x (0.1.0: 5.3x).

The list arm reproduces 0.1.0 to within 0.2 GiB.

**Where the Qwen 20k peak comes from.** With packmem, the node peak equals the "before iteration" peak (5.77 GiB).
All 8 ranks run `load_json` on the same 1 GB file at once, each on up to 4 threads. That transient is the peak.
In 0.1.0 the one-thread loader peaked at 4.40 GiB before iteration, and the node peak (4.86) came during
iteration. Once loaded, 0.3.2 holds less: steady 4.53 against 4.83 GiB. On the full shard the iteration peak
(6.21) is above the load transient (5.84), so 0.3.2 comes out lower than 0.1.0 there. A `threads=`
argument for the loaders is on main, unreleased; the transient at 1, 2 and 4 threads is being measured.

**MiniCPM is 0.18 GiB higher at the peak and 0.22 GiB higher in the steady state** than 0.1.0 (7.31 against 7.13,
and 7.21 against 6.99). Its load transient is also higher (6.93 against 5.34 before iteration). Why the steady
state is higher was not investigated.

### Correctness

Collated `input_ids`, `labels` and `position_ids` are hashed per rank and batch, in order. This time all 8 ranks are
compared in every run. Every rank has one hash triple:
- Qwen 20k: across all 6 runs.
- Qwen shard: across both runs.
- MiniCPM 20k: across all 6 runs.

The `DistributedSampler` index hashes match too.

Ranks 0-2 match the 0.1.0 hashes quoted in RESULT.md:
- Qwen rank 0: `619afe7b63985e93... / 776a1b7955fad35f... / bac2c498c1619d63...`.
- MiniCPM ranks 0-2: `59416b8b...`, `93f554ef...`, `30053b6c...`.

MiniCPM ranks 3-7, which 0.1.0 could not confirm, are now confirmed equal between arms.

### Load and time

The server also runs CI.
- **Qwen:** the first list run started at 0.91. Four runs hit the 10-minute wait and started at loads up to 32.7:
  pm r1 32.66, pm r3 30.77, and list r2 and the shard list at 3.3 and 5.5 after waiting.
- **MiniCPM:** the r1 runs started near 3.7. r2 and r3 started at 21.7-39.8 and ended at 43-70.
- **Per run:** `meta.json` in each run directory has the start and end load, the seconds waited and
  `MemAvailable` at the start.

Memory is summed over the job's own processes and stays consistent across runs (list within 0.2 GiB, packmem
within 0.35 GiB). Times are not comparable between runs, and none are reported as results.

## Where 0.3.2 is worse than 0.1.0

**`load_json` peaks higher.** It loads this file 5.7x faster than 0.1.0, but its transient peak is about 335 MiB
higher. The two times are not like for like. Since 0.3.0, `load_json` memory-maps files of 8 MB or more and
parses them on up to 4 threads (`PACKMEM_THREADS`), while 0.1.0 parsed on one thread. Those threads cost the
higher transient peak. `harness/load_peak.py` loads the file in a fresh process, 3 runs per version, with the
default thread count. Raw output: [`results/0.3.2/load_peak/runs.jsonl`](results/0.3.2/load_peak/runs.jsonl).

| | packmem 0.1.0 | packmem 0.3.2 |
| --- | --- | --- |
| `load_json` time | 8.25-8.40 s (1 thread) | 1.43-1.51 s (up to 4 threads, mmap) |
| Peak RSS (ru_maxrss) | 398-399 MiB (1 thread) | 719-736 MiB (up to 4 threads) |
| RSS after load | 354 MiB | 329-340 MiB |
| `Table.nbytes` | 307.6 MB | 296.2 MB |

This is why the main-process-only peak (1.04 GiB) sits above its steady value (0.70 GiB). Every packmem
row's "before iteration" figure includes it too, and so does the rank peak PSS of 0.82-0.91 GiB, against
0.53 GiB in the 0.1.0 run. The settled table is slightly smaller than in 0.1.0. The extra peak lasts only for the load,
once per rank.

On 8 ranks at once this transient sets the node peak at 20k samples per rank: 5.77 GiB against 0.1.0's
4.86 (above). MiniCPM-V at 8x4 is also 0.18 GiB higher at the peak and 0.22 GiB higher in the steady state.

### The transient by thread count

Measured afterwards (2026-11-15, one process, 3 runs per row, the file warm in the page cache, 1-minute load 2.4 to 3.0
at every start). A separate process read the loader's `/proc/<pid>/status` every 2 ms; its sampled VmRSS peak is
within 2 MiB of the loader's own VmHWM in every run. Harness: `harness/load_threads.py`. Raw output and versions:
[`results/0.3.2/load_threads/`](results/0.3.2/load_threads/). Medians, MiB:

| Threads | `load_json` time | Peak RssAnon | Peak RssFile | Peak VmRSS | RssAnon after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 6.42 s | 372 | 9 | 381 | 308 |
| 2 | 2.19 s | 479 | 185 | 577 | 309 |
| 4 (default) | 1.48 s | 613 | 261 | 741 | 332 |

- **Anonymous memory** grows by about 80 MiB per extra parser thread (372 to 613 MiB from 1 to 4 threads), and this
  is what raises node PSS at 8 ranks.
- **File pages** are the memory-mapped input (9 MiB at 1 thread, 185 to 261 MiB with more). All ranks map the same
  file, so across the node they count about once.
- **At one thread,** 0.3.2 peaks at 381 MiB in 6.4 s, against 0.1.0's 399 MiB in 8.3 s.

These rows use packmem 0.3.2 from PyPI with `PACKMEM_THREADS` set, which also turns off threaded queries. Main at
c358143 (unreleased) adds `load_json(path, threads=n)`, which leaves queries threaded. Built from that commit and run
the same way, it gave the same figures: 380, 580 and 726 MiB peak VmRSS at 1, 2 and 4 threads, in 6.45, 2.19 and
1.47 s. The table was the same size (`nbytes` 296,187,892) in all 18 runs. The 8-rank node runs above were not
repeated with one thread.

Main at c7898e9 (unreleased) releases the mapped input behind each parser thread as it goes. Built from that commit
and run the same way with `threads=` (3 runs each, `runs-c7898e9.jsonl`), medians in MiB:

| Threads | `load_json` time | Peak RssAnon | Peak RssFile | Peak VmRSS | c358143 peak VmRSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 6.45 s | 372 | 9 | 381 | 380 |
| 2 | 2.22 s | 480 | 135 | 492 | 580 |
| 4 | 1.49 s | 611 | 144 | 623 | 726 |

File pages fell by 50 MiB at 2 threads and by 117 MiB at 4. Anonymous memory and time did not change. A memray 1.20
`--native` profile of a build with debug symbols (`memray-*-c7898e9*`; grouped by `memray_hwm.py`) puts the extra
anonymous memory at 4 threads in the parser threads' column builders (`push_line` and `RowSeed::visit_map`), which are
still alive when the high-water mark is reached. memray counts reserved capacity, so its 1.64 GB peak is well above
the 623 MiB that is resident.

The next three commits tested where that memory comes from. All were measured the same way, at 4 threads unless a
row says otherwise. Raw files are in [`f6973f1/`](results/0.3.2/load_threads/f6973f1/) and
[`752a515/`](results/0.3.2/load_threads/752a515/). Medians, MiB:

| Build | Time | Peak RssAnon | RssAnon after |
| --- | ---: | ---: | ---: |
| f6973f1: cap on input being unpacked at once, off / 32 / 8 MiB per thread | 1.46 / 1.53 / 3.50 s | 612 / 611 / 630 | 322 / 310 / 320 |
| f6973f1 with row buffers never reused (`exp-drop-spare.diff`, not pushed) | 1.48 s | 622 | 322 |
| 752a515: buffers over 16 MiB freed after each piece | 1.47 s | 669 | 361 |
| f6973f1, `MALLOC_MMAP_THRESHOLD_=1048576` | 1.69 s | 521 | 296 |
| 752a515, `MALLOC_MMAP_THRESHOLD_=1048576` | 1.56 s | 441 | 299 |
| 752a515, `MALLOC_MMAP_THRESHOLD_=1048576`, 2 threads / 1 thread | 2.37 / 6.55 s | 384 / 365 | 298 / 299 |

Limiting the input being unpacked at once and dropping reused buffers did not lower the peak. Freeing more made it
higher. Fixing glibc's mmap threshold brought 4 threads to within 76 MiB of one thread. glibc raises that threshold
each time a large mapped block is freed, after which the parser threads' multi-MiB buffers come from per-thread arenas
and are not returned. The per-piece JSON sizes (5 to 54 MB per 16,384 records, heaviest at the end of the file) are in
`f6973f1/piece_bytes.json`. 5f4b8e3 gives packmem's own large blocks their own mapping on Linux instead of changing
glibc settings for the whole process. 4bf9c3e keeps that only on the load threads, so queries and the one-thread load
stay on malloc.

Those three builds, measured the same way with no `MALLOC_` variables (raw files in `5f4b8e3/`, `5df3b63/` and
`4bf9c3e/`; `query.jsonl` times `t.col("conversations").list.len()` 5 times in each of two processes per build, against
f6973f1 in the same session). Medians, MiB:

| Build | Peak RssAnon, 1 / 2 / 4 threads | RssAnon after, 4 threads | Time, 1 / 4 threads | `list.len()` | f6973f1 `list.len()` |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5f4b8e3: blocks of 1 MiB or more mapped, every thread | 365 / 384 / 445 | 299 | 6.65 / 1.54 s | 7.0 to 7.9 ms | 3.8 ms |
| 5df3b63: mapped from 16 MiB | 389 / 486 / 615 | 334 | 7.04 / 1.50 s (load 3.5) | 3.9 to 4.0 ms | 3.8 ms |
| 4bf9c3e: from 1 MiB on load threads only | 376 / 384 / 442 | 303 | 6.39 / 1.54 s | 3.8 to 3.9 ms | 3.8 to 4.0 ms |

On 4bf9c3e, dropping the loaded table (`del t` with `gc.collect()`) took 20.6 and 21.6 ms against 17.0 and 18.9 ms
on f6973f1.

### 8 ranks x 4 fork workers on main 4bf9c3e

The packmem arms of the 8-rank study, re-run on main at 4bf9c3e (unreleased) on 2026-11-15, 22:27 to 22:49 CET.
Order: `results/4bf9c3e-8x4/seq_pm.sh`, 3 runs per configuration, 1 for the shard, 40 GiB cap. The list arms were not
re-run, because list memory does not depend on packmem. The list column is the 0.3.2 run above.

Setup: the same repository commits and patches (sha256 checked), data and harness as the 0.3.2 run. Two differences
(`results/4bf9c3e-8x4/env-4bf9c3e.txt`):
- the Qwen venv also has torchvision 0.29.2+cpu, which the 0.3.2 env file does not list;
- packmem is a local `manylinux_2_34` build of 4bf9c3e (rustc 1.100.0), where 0.3.2 used the PyPI `manylinux2014` wheel.

Node-wide PSS, GiB (median (min-max)):

| model | samples / rank | list (0.3.2) | 0.1.0 packmem | 0.3.2 packmem | **4bf9c3e packmem** | list / 4bf9c3e |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen | 20,000 | 47.81 | 4.86 | 5.77 | **4.47** (4.47-4.50) | 10.7x |
| Qwen | 83,163 (shard) | 54.88 | 6.55 | 6.21 | **6.12** | 9.0x |
| MiniCPM | 20,000 | 37.82 | 7.13 | 7.31 | **7.25** (7.23-7.25) | 5.2x |

- **Qwen 20k:** the peak falls by 1.3 GiB from 0.3.2 and is now 0.4 GiB below 0.1.0. The peak before iteration (the
  8 concurrent `load_json` calls) is 4.34 GiB, against 5.77 on 0.3.2.
- **Shard:** 6.12 GiB. Here the peak comes from iteration, not from loading, so it barely moves.
- **MiniCPM:** about the same as 0.3.2 and 0.12 GiB above 0.1.0. Its peak also comes from iteration (7.14 GiB
  steady), not from the load.
- **Batches:** identical. The per-rank `input_ids`, `labels` and `position_ids` hashes match across all 9 runs at
  20k per rank (0.3.2 list, 0.3.2 packmem and 4bf9c3e packmem), for both models, and across 3 runs for the shard:
  `results/4bf9c3e-8x4/compare_032_{q,m}.md`.
- **Load:** the 1-minute load average was at or under 4 at each start. The MiniCPM runs pushed it to 38-46 by their
  end (their loader runs about 160 s), so their times are indicative only. Memory is the result.

Full tables: [`aggregate_q.md`](results/4bf9c3e-8x4/aggregate_q.md) and
[`aggregate_m.md`](results/4bf9c3e-8x4/aggregate_m.md).

## Not measured here

- forkserver and spawn at 8 or 2 ranks, which 0.1.0 also ran. Their 0.1.0 figures remain without raw files.
- MiniCPM-V spawn, single-rank runs and record check; LLaVA-NeXT and NeMo Automodel were not re-run.
- `PACKMEM_THREADS=1` at 8 ranks.
- Images, the model and real tokenization. The stubs are the same as in every earlier run, so the figures cover
  annotation storage only.
