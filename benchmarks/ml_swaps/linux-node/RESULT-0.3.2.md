# qwen-vl-finetune on Linux with packmem 0.3.2: one rank, a full shuffled epoch through 4 workers

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
- runs **one rank** with the full epoch, as on a single-GPU job, instead of 8 ranks. The list arm at 8x4 needs
  about 48 GiB, more than this session's 40 GiB cap per run. Per rank, the two runs agree. Spawn, per rank (rank + 4
  workers at the peak): 0.1.0 at 2x4 with 20k samples, 14.85 against 2.41 GiB (6.2x). 0.3.2 at 1x4 with the full
  epoch, 15.17 against 2.52 GiB (6.0x);
- caps every run with `systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0` and `nice -n 10`, one run at
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
| Dataset build (`json.load` / `load_json` + `data_path`) | 4.85 s | 2.50 s |
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

## Where 0.3.2 is worse than 0.1.0

**`load_json` peaks higher.** It is 5.7x faster than in 0.1.0, but its transient peak is about 335 MiB higher.
`harness/load_peak.py` loads the file in a fresh process, 3 runs per version. Raw output:
[`results/0.3.2/load_peak/runs.jsonl`](results/0.3.2/load_peak/runs.jsonl).

| | packmem 0.1.0 | packmem 0.3.2 |
| --- | --- | --- |
| `load_json` time | 8.25-8.40 s | 1.43-1.51 s |
| Peak RSS (ru_maxrss) | 398-399 MiB | 719-736 MiB |
| RSS after load | 354 MiB | 329-340 MiB |
| `Table.nbytes` | 307.6 MB | 296.2 MB |

This is why the main-process-only peak (1.04 GiB) sits above its steady value (0.70 GiB). Every packmem
row's "before iteration" figure includes it too, and so does the rank peak PSS of 0.82-0.91 GiB, against
0.53 GiB in the 0.1.0 run. The settled table is slightly smaller than in 0.1.0. The extra peak lasts only for the load,
once per rank.

## Not measured here

- 8 ranks on one node, and forkserver. Those configurations exceed this session's 40 GiB per-run cap, and their
  0.1.0 figures (47.7 -> 4.9 GiB at 8x4 fork) remain without raw files.
- MiniCPM-V, LLaVA-NeXT and NeMo Automodel were not re-run.
- Images, the model and real tokenization. The stubs are the same as in every earlier run, so the figures cover
  annotation storage only.
