# packmem on a Linux node: 8 torchrun ranks x 4 DataLoader workers, real LLaVA-665k

**Headline (qwen-vl-finetune, measured, not extrapolated):** 8 ranks x 4 fork workers, real
LLaVA-1.5 665k annotations, 20k samples per rank: **47.7 GiB -> 4.9 GiB** node-wide PSS (peak,
median of 3 runs, 9.8x lower). One full pass over each rank's 1/8 shard (83,163 samples per rank):
**54.7 GiB -> 6.6 GiB** (1 run each, 8.4x lower). Collated `input_ids`, `labels` and `position_ids`
are bit-identical between the arms for every rank, start method and run.

All numbers are host RAM for annotation storage plus the Python/torch processes around it. There
are no images, no model and no GPU. GiB = 2^30 bytes.

**MiniCPM-V `finetune.py` / `SupervisedDataset`** (same data in MiniCPM format, measured): 8 ranks x 4
fork workers, 20k samples per rank: **37.9 GiB -> 7.1 GiB** (median of 3, 5.3x lower). With
forkserver at 2 ranks x 4 workers: 31.6 GiB -> 6.4 GiB (4.9x).

**What is not measured:** the list-of-dicts arm with forkserver or spawn at 8x4. That would need
about 117-126 GiB, so it ran at 2x4. Python 3.14, where forkserver becomes the default, was not
tested (this was 3.12.3).

## Environment

| | |
| --- | --- |
| Machine | `linux-server`, shared: 7 logged-in users, other CI-like jobs running, up 33 days |
| CPU | AMD Ryzen 9 7950X3D, 16 cores / 32 threads |
| RAM | 124 GiB (3 GiB swap; runs had `MemorySwapMax=0`, no swap was used) |
| OS / kernel | Ubuntu 24.04.5 LTS, Linux 6.8.0-139-generic x86_64, glibc 2.39 |
| THP / KSM | `transparent_hugepage=madvise`, KSM off |
| Python | 3.12.3 (system), venvs from `python3 -m venv` (uv is not installed) |
| torch | 2.15.0+cpu (`--index-url https://download.pytorch.org/whl/cpu`), gloo backend |
| packmem | 0.1.0 from PyPI, wheel `packmem-0.1.0-cp310-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl` (sha256 `924f0879...908f`) |
| Qwen venv | transformers 5.23.0, numpy 2.5.4 |
| MiniCPM venv | transformers 4.51.2, deepspeed 0.20.0, peft 0.14.0, accelerate 0.30.1, torchvision 0.29.2+cpu (versions as in the macOS run) |
| Qwen3-VL | fresh `git clone --depth 1 https://github.com/QwenLM/Qwen3-VL`, commit `96588727e44c` (same as macOS), `packmem.v2.patch` applied in a worktree (`repos/qwen-pm`, +29/-12 in `data_processor.py`) |
| MiniCPM-V | fresh `git clone --depth 1 https://github.com/OpenBMB/MiniCPM-V`, commit `4dbbb6c58b6f` (same as macOS), `packmem.v2.patch` applied (`repos/minicpm-pm`, +10/-7) |
| Data | `llava_v1_5_mix665k.json`, 1,029,887,963 bytes, sha256 `ce959ce6...6cf8`, 665,298 records, copied from the Mac. The MiniCPM-format file was regenerated on the server with the same `convert.py` and is byte-identical to the macOS one (sha256 `1a59b9b1...00ef`). |

Load average during the runs ranged from about 15 to 66 (32 hardware threads). Other users' jobs
accounted for roughly 15-35 of that. Every run's start and end load average is listed below.
Timings are therefore noisy. The memory numbers are not affected, because PSS is summed only over
the processes of the run.

## Method

### Workload

Each torchrun rank does what the training script does before the model sees a batch:

1. `dist.init_process_group("gloo")`.
2. Build the dataset with the repo's own class:
   - Qwen: `qwenvl.data.data_processor.LazySupervisedDataset(processor, DataArguments(dataset_use="llava665k"))`, `model_type="qwen2.5vl"`, so the original tree runs `json.load` and the patched tree runs `packmem.load_json` plus the `data_path` assignment through `Table.lazy()`.
   - MiniCPM: `finetune.make_supervised_data_module(...)`, `llm_type="qwen"`, `batch_vision=True`, default slice config, as in the macOS harness.
3. `dist.barrier()`.
4. `DistributedSampler(ds, num_replicas=8, rank=RANK, shuffle=True, seed=0)`, epoch 0, and take the
   first 20,000 indices (or the whole shard of 83,163). `num_replicas` is always 8, so a run with
   fewer launched ranks gives each rank exactly the shard it would have in the 8-rank job.
5. `DataLoader(ds, batch_size=4 (Qwen) / 8 (MiniCPM), sampler=<those indices>, num_workers=4,
   multiprocessing_context=<fork|forkserver|spawn>, prefetch_factor=2)` with the repo's collator,
   iterated once. Each batch's tensors are hashed.

Stubs are the same as on macOS and identical for both arms. Qwen uses a deterministic tokenizer
that turns text and the image path into ids, with no image decoding. MiniCPM uses the same
word-level tokenizer and an `Image.open` that returns a small generated image derived from the
path. For spawn and forkserver they live in importable modules (`qstubs.py`, `mstubs.py`).

### Memory measurement

`monitor.py` starts torchrun and every 0.5 s finds all of its descendants: the launcher, 8 ranks,
32 workers, plus forkserver and resource-tracker processes when they exist. It reads
`/proc/<pid>/smaps_rollup` for each one (Rss, Pss, Pss_Anon, Private_*, SwapPss) using 12
threads. Reported values:

- **node PSS**: sum of Pss + SwapPss over all of those processes. This is the real RAM the job
  uses, with each shared page counted once. Summed RSS is shown for contrast. It counts pages
  that fork workers share with their rank many times over.
- **peak**: maximum over all samples.
- **steady**: median node PSS over the second half of the window in which every rank is iterating
  (from the last rank's first batch to the first rank's last batch). The list arm keeps growing
  during iteration, so "steady" there means "late in the run", not "flat".
- **pre-iteration peak**: maximum before any rank starts its DataLoader. This includes the
  `json.load` / `load_json` transients.
- **per-rank total**: at the peak sample, the PSS of one rank plus its workers, forkserver and
  tracker (median over ranks).
- Per-process peaks for ranks and workers (PSS, RSS, USS = private clean + private dirty).

Sampling cost: reading `smaps_rollup` of a 4 GB process takes about 0.15-0.3 s of kernel time.
In the list-arm 8x4 runs the sampling interval stretched to a median of 0.6 s, with single gaps up
to 2.3 s. Elsewhere it was 0.50 s. Short spikes in the list arm can therefore be slightly
underestimated.

Time to first batch per worker comes from `worker_init_fn` and the collate function, which each
worker records to `out/<run>/probe/w<pid>.json`. It is reported relative to the rank's `iter()`
call.

### Safety

Every run is `systemd-run --user --scope -p MemoryMax=70G -p MemorySwapMax=0 -- nice -n 10 ...`.
`run.sh` waits (up to 30 min) until `MemAvailable` is at least 30 GB above the run's expected peak,
which comes from 1-rank calibration runs. `monitor.py` kills the job if `MemAvailable` drops below
25 GiB. No run was killed or skipped. The lowest `MemAvailable` seen during any run was 48 GiB
(list arm, 8x4 fork).

The list arm with forkserver or spawn pickles the whole dataset into every worker, so each worker
holds its own 3.1 GiB copy and one rank with 4 workers needs about 14.6 GiB. 8x4 would be about
117 GiB, so those arms were run with **2 ranks x 4 workers** (shards 0 and 1 of 8). Per-rank
numbers are reported, and packmem was run at both 2x4 and 8x4 for comparison.

### Runs

Arms were interleaved (list, packmem, list, ...). Every run is a fresh torchrun job. There were 3
runs per configuration with 20k samples and 1 run per configuration for the full shard. Medians
are shown with min-max in parentheses.

## Results: Qwen3-VL qwen-vl-finetune (`LazySupervisedDataset`)

### Node-wide memory

| start method | ranks x workers | samples / rank | arm | node PSS peak | node PSS steady | per-rank total at peak | sum of RSS (peak) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fork | 8 x 4 | 20,000 | list (`json.load`) | **47.73** (47.59-47.86) | 46.62 | 5.95 | 116.4 |
| fork | 8 x 4 | 20,000 | packmem | **4.86** (4.85-4.86) | 4.83 | 0.59 | 21.9 |
| fork | 8 x 4 | 83,163 (full shard) | list | **54.69** | 52.04 | 6.82 | 117.0 |
| fork | 8 x 4 | 83,163 (full shard) | packmem | **6.55** | 6.45 | 0.80 | 22.6 |
| forkserver | 2 x 4 | 20,000 | list | **29.41** (29.41-29.56) | 28.71 | 14.63 | 30.3 |
| forkserver | 2 x 4 | 20,000 | packmem | **5.13** (4.98-5.40) | 4.89 | 2.49 | 6.0 |
| forkserver | 8 x 4 | 20,000 | packmem | **19.94** (19.63-20.09) | 18.88 | 2.46 | 23.5 |
| forkserver | 2 x 4 | 83,163 (full shard) | list | **29.72** | 28.75 | 14.78 | 30.6 |
| forkserver | 8 x 4 | 83,163 (full shard) | packmem | **19.88** | 19.02 | 2.52 | 23.4 |
| spawn | 2 x 4 | 20,000 | list | **29.84** (29.83-29.95) | 28.71 | 14.85 | 30.7 |
| spawn | 2 x 4 | 20,000 | packmem | **4.96** (4.91-5.34) | 4.89 | 2.41 | 5.8 |
| spawn | 8 x 4 | 20,000 | packmem | **19.62** (19.56-20.09) | 18.87 | 2.40 | 23.1 |

All values are in GiB. For forkserver and spawn the list arm was not run at 8x4. Arithmetic on the
per-rank total gives about 8 x 14.6 + 0.15 = **~117 GiB**, against a measured 19.9 GiB for
packmem. That 117 GiB figure is extrapolated, not measured.

### Where the memory is (per process, peak PSS, median over processes)

| config | arm | rank (main) PSS | rank USS | worker PSS | worker USS | worker RSS | pre-iteration node peak |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fork 8x4, 20k | list | 3.82 | 3.81 | 1.21 | 0.77 | 2.89 | 30.67 |
| fork 8x4, 20k | packmem | 0.53 | 0.52 | 0.12 | 0.02 | 0.53 | 4.40 |
| fork 8x4, shard | list | 3.82 | 3.81 | 1.41 | 0.99 | 2.91 | 30.68 |
| fork 8x4, shard | packmem | 0.53 | 0.52 | 0.16 | 0.06 | 0.55 | 4.31 |
| forkserver 2x4, 20k | list | 4.93 | 4.92 | 3.09 | 3.08 | 3.16 | 7.83 |
| forkserver 8x4, 20k | packmem | 1.08 | 1.05 | 0.53 | 0.53 | 0.61 | 4.29 |
| spawn 2x4, 20k | list | 4.93 | 4.92 | 3.09 | 3.08 | 3.16 | 7.83 |
| spawn 8x4, 20k | packmem | 1.09 | 1.08 | 0.49 | 0.49 | 0.57 | 4.33 |

All values are in GiB. Breakdown at the node peak, fork 8x4 20k:

- list: ranks 9.2 GiB of PSS and workers 38.2 GiB, out of 47.7. The ranks' 30.6 GiB of private
  list memory is split between each rank and its workers because the workers still share most of
  it.
- packmem: ranks 1.0 GiB and workers 3.7 GiB, out of 4.9.

How to read this:

- **fork, list arm.** Each worker starts out sharing its rank's 3.8 GiB of dicts. Each worker
  then privately copies 0.77 GiB (20k samples) to 0.99 GiB (full shard), because touching a
  record writes its refcount and the GC walks the objects. That is 32 x 0.8-1.0 GiB of duplicated
  pages per node, on top of 8 x 3.8 GiB of lists.
- **fork, packmem.** The table is about 0.3 GiB per rank and is never written after fork, so
  workers keep it shared. Each worker's private memory is 16-60 MB.
- **forkserver/spawn, list arm.** Each worker unpickles its own full copy (3.1 GiB). The rank
  peaks at 4.9 GiB while it pickles a 690 MB payload for each worker.
- **forkserver/spawn, packmem.** Each worker unpickles a 0.3 GiB table, and its private memory is
  about 0.5 GiB. The rest is torch/transformers/qwenvl imports, because on Python 3.12 forkserver
  workers re-import `__main__` (see caveats). That is why packmem at 8x4 needs 19.9 GiB with
  forkserver against 4.9 GiB with fork.

### Time

| config | arm | dataset build per rank (s) | DataLoader pass per rank (s) | worker first batch after `iter()` (s, median / max) | load avg start -> end |
| --- | --- | --- | --- | --- | --- |
| fork 8x4, 20k | list | 12.4 (9.0-12.6) | 61.3 (35.0-67.8) | 0.78 / 7.42 | 33->66; 57->65; 56->45 |
| fork 8x4, 20k | packmem | 16.2 (12.2-19.0) | 20.4 (14.4-33.8) | 0.18 / 0.26 | 66->57; 65->56; 45->44 |
| fork 8x4, shard | list | 10.0 | 112.9 | 0.69 / 6.99 | 38->47 |
| fork 8x4, shard | packmem | 13.8 | 58.0 | 0.11 / 0.13 | 33->38 |
| forkserver 2x4, 20k | list | 5.9 | 66.2 (63.1-67.6) | **50.4 / 51.9** | 32->19; 29->18; 20->16 |
| forkserver 2x4, 20k | packmem | 11.1 | 15.2 (14.8-18.5) | 8.9 / 9.1 | 41->32; 26->29; 25->20 |
| forkserver 8x4, 20k | packmem | 12.1 | 24.1 | 11.4 / 11.8 | 44->41; 19->26; 18->25 |
| forkserver 2x4, shard | list | 8.5 | 133.4 | 74.8 / 77.2 | 44->38 |
| forkserver 8x4, shard | packmem | 12.4 | 73.3 | 12.0 / 12.5 | 38->44 |
| spawn 2x4, 20k | list | 8.0 | 110.2 (69.3-112.1) | **79.6 / 82.3** | 30->22; 29->35; 44->33 |
| spawn 2x4, 20k | packmem | 12.4 | 17.7 | 9.8 / 10.2 | 34->30; 32->29; 50->44 |
| spawn 8x4, 20k | packmem | 13.3 | 33.7 | 14.1 / 14.4 | 16->34; 22->32; 35->50 |

- **Build is slower with packmem**: about 16 s against 12 s with 8 ranks loading at once, and 14.1
  s against 7.8 s for a single process (`qwen_single.py`). This is the known `load_json` cost on
  this file and is paid once per rank.
- **The DataLoader pass is shorter with packmem** in every configuration here. The "DataLoader pass"
  column includes worker startup. With fork, part of the difference is the list arm's slower
  worker startup (forking a 4 GB process, up to 7.4 s before a worker's first batch, while 8 ranks
  fork at once). The rest is CPU contention on a box at load 45-66 and should not be read as a
  throughput claim.
- **forkserver/spawn startup**: the list arm takes 50-80 s before workers deliver their first batch.
  The rank pickles the 690 MB dataset once per worker (12.7 s each, serially) and each worker
  unpickles it. With packmem this takes 9-14 s, which is mostly the workers importing torch and
  transformers. Under spawn and forkserver the list arm is not just larger but also adds about a
  minute to the start of every epoch, because workers are not persistent by default.

### Pickled dataset size (`qwen_single.py pickle`, single process)

| | list | packmem |
| --- | --- | --- |
| `pickle.dumps(dataset)` size | 689.8 MB | 309.2 MB (`Table.nbytes` 310.7 MB) |
| dumps time (3 runs) | 12.6 / 12.8 / 12.8 s | 0.91 / 1.00 / 1.00 s |
| loads time | 5.70 s | 0.39 s |
| round trip equal | yes | yes |
| process max RSS | 6,679 MiB | 1,475 MiB |

The load average was about 30 during this measurement.

### Correctness (Qwen)

- **Records**: `qwen_single.py verify` writes sha256(`json.dumps(row, sort_keys=True)`) for every
  row of `list_data_dict`. The 665,298 x 32-byte digest files of the two arms are byte-identical
  (`cmp`). The combined hash is `d566b270f1dd6211...` for both.
- **Batches**: for each rank the run hashes every collated `input_ids`, `labels` and `position_ids`
  tensor in order. For the 20k index set, ranks 0 and 1 have one hash triple across all 24 runs
  that include them (list and packmem, fork, forkserver and spawn, 2- and 8-rank jobs). Ranks 2-7
  have one triple across 12 runs each. For the full shard, every rank has one triple across all
  runs (3-4 each). The `DistributedSampler` index lists are also identical (hashed per rank).
  Example, rank 0 at 20k: `input_ids 619afe7b63985e93...`, `labels 776a1b7955fad35f...`,
  `position_ids bac2c498c1619d63...`.

## Results: MiniCPM-V (`finetune.make_supervised_data_module` / `SupervisedDataset`)

Batch size 8, stub images (small generated PIL images, so the repo's slicing, resizing and
`ToTensor` run), stub tokenizer, `llm_type="qwen"`. This is more CPU per sample than Qwen, so these
runs were long (4.5-6.5 min each at 8x4) on a box at load 65-92. Given that load, MiniCPM was cut
to fork 8x4 (3 runs per arm), forkserver 2x4 (3 runs per arm) and forkserver 8x4 packmem (1 run).
**MiniCPM spawn and full-shard runs were not done.** Qwen covers both. 1-rank calibration runs of
the list arm (fork, 1x4) are included.

| start method | ranks x workers | samples / rank | arm | node PSS peak | node PSS steady | per-rank total at peak | rank PSS | worker PSS / USS | pre-iteration peak | sum RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fork | 8 x 4 | 20,000 | list | **37.89** (37.85-37.94) | 37.01 | 4.72 | 4.01 | 0.86 / 0.23 | 32.24 | 124.3 |
| fork | 8 x 4 | 20,000 | packmem | **7.13** (7.06-7.19) | 6.99 | 0.88 | 0.65 | 0.20 / 0.08 | 5.34 | 27.7 |
| fork | 1 x 4 (calibration) | 20,000 | list | 4.23 | 4.05 | 4.05 | 4.05 | 0.82 / 0.23 | 4.23 | 15.7 |
| fork | 1 x 4 (calibration) | 83,163 (full shard) | list | 6.16 | 5.78 | 5.98 | 4.05 | 1.13 / 0.52 | 4.23 | 15.9 |
| forkserver | 2 x 4 | 20,000 | list | **31.57** (31.42-31.61) | 30.68 | 15.71 | 5.12 | 3.26 / 3.25 | 8.23 | 32.5 |
| forkserver | 2 x 4 | 20,000 | packmem | **6.41** (6.41-6.51) | 6.34 | 3.13 | 1.19 | 0.64 / 0.63 | 1.51 | 7.4 |
| forkserver | 8 x 4 | 20,000 | packmem (1 run) | **24.88** | 24.73 | 3.09 | 1.22 | 0.70 / 0.69 | 5.29 | 29.0 |

All values are in GiB. Extrapolated, not measured: the list arm with forkserver at 8x4 would be
about 8 x 15.7 = 126 GiB, against a measured 24.9 GiB for packmem.

| config | arm | build per rank (s) | DataLoader pass per rank (s) | worker first batch after `iter()` (s, median / max) | load avg start -> end |
| --- | --- | --- | --- | --- | --- |
| fork 8x4 | list | 9.9 (9.3-11.2) | 282 (253-291) | 0.98 / 1.56 | 27->73; 88->92; 65->77 |
| fork 8x4 | packmem | 15.7 (15.4-16.7) | 271 (257-356) | 0.54 / 0.97 | 73->88; 92->65; 77->90 |
| forkserver 2x4 | list | 7.0 (6.5-8.9) | 201 (169-220) | **75.2 / 77.1** | 39->53; 38->47; 35->28 |
| forkserver 2x4 | packmem | 14.4 (13.8-15.0) | 109 (106-110) | 22.4 / 22.7 | 28->39; 53->38; 47->35 |
| forkserver 8x4 | packmem | 18.2 | 359 | 31.0 / 36.5 | 90->74 |

- In this repo the list-arm fork workers copy less (0.23 GiB USS each at 20k samples, against
  0.77 GiB in Qwen). The node total is dominated by the 8 x 4.0 GiB lists themselves, so the
  ratio is 5.3x rather than Qwen's 9.8x.
- Under forkserver the list arm again needs over a minute before the first batch (pickling about
  670 MB per worker), and each worker holds a 3.3 GiB copy.

### Correctness (MiniCPM)

- **Records**: `mcpm_single.py` hashes `json.dumps(row, sort_keys=True)` for every row of
  `train_dataset.raw_data`. The 665,298 per-record digests are byte-identical between arms.
  The combined hash is `21758dc54526328a...` for both.
- **Batches**: `input_ids`, `labels` and `position_ids` hashes per rank are identical across arms
  and start methods.
  - Rank 0: `59416b8b0d4d029e... / e94e6c6b528261f0... / 3f5bddf67537a387...` in all 14 runs at 20k
    that include it (fork 8x4 x6, the fork 1x4 calibration, forkserver 8x4 packmem, forkserver
    2x4 x6).
  - Rank 1: `93f554ef2ca7dc28...` in all 13. Rank 2: `30053b6ca4f182c2...` in all 7.
  - For ranks 3-7 of the fork 8x4 runs, the comparison output was truncated in the terminal before
    the rank files were deleted, so their equality is **not confirmed**.
  - The hash of every `pixel_values` tensor was identical across the 6 forkserver 2x4 runs (rank 0
    `00b28073...`, rank 1 `403cf325...`).

## Differences from the macOS results

- **Pickling works.** The first macOS write-ups said `packmem.Table` cannot be pickled. With the
  published 0.1.0 wheel it pickles on Linux, and forkserver and spawn workers ran without errors
  in both repos.
- **Per rank, Linux shows a larger ratio.** Qwen, 1 rank with 4 fork workers and 20k samples, on
  macOS (`phys_footprint`, main + workers): 7.1 GB against 1.2 GB (5.9x). On Linux (PSS, per-rank
  total inside the 8-rank job): 5.95 GiB against 0.59 GiB (10x). PSS splits torch's and the
  shared libraries' pages across all 41 processes. macOS footprint charges every process for its
  own dirty pages. The list-of-dicts cost is similar on both: a 3.8 GiB rank on Linux against
  about 5.2 GB on macOS (Python 3.13 there, 3.12 here).
- **MiniCPM per rank** (4 fork workers, 20k samples): macOS main + workers was 6.8 GB against
  1.4 GB (4.8x). Linux per-rank total is 4.72 against 0.88 GiB (5.4x). Same direction, similar
  size.
- **The 8-GPU node is now measured.** macOS extrapolated "roughly 131 GB against 18 GB" for 8
  ranks, assuming each rank reads all 665k records. With a realistic `DistributedSampler` shard
  (83k per rank) the measured node figure is 54.7 GiB against 6.6 GiB.
- **Worker growth is smaller per worker on Linux in this setup** (0.77 GiB at 20k, 0.99 GiB at the
  full shard) than in the macOS single-rank full epoch (2.8 GB at 665k samples per worker set).
  Each worker here touches about 21k records, not 166k.
- **Build time** is slower with packmem on both, by similar factors (macOS 3.6 s -> 8.9 s, Linux
  7.8 s -> 14.1 s for a single process under load).

## packmem bugs found on Linux

None. No crashes, no wrong results, no pickling errors under fork, forkserver or spawn, and no
differences in any record or batch. Observations that matter for users:

- Under forkserver and spawn each worker gets its own unpickled copy of the table (0.3 GiB here,
  32 copies = about 9.3 GiB per node). Only fork shares it. A shared-memory or mmap-backed pickling
  path would remove that.
- `load_json` takes about 1.8x as long as `json.load` on this file (single process, loaded box).

## Caveats

- **The whole `~/packmem-bench` directory was deleted by something outside this job** at about
  17:46 server time, after all Qwen runs and the MiniCPM fork runs had finished. Earlier sessions'
  files (`packmem`, `rustup`, `cargo`, ...) went with it. None of this job's scripts remove anything
  above `out/<run>/`. Another session was active on the box in `~/packmem-tokbench`, and the cause
  was not found. Lost: the raw `monitor.jsonl` traces and per-rank JSON of every Qwen run and of
  the MiniCPM fork runs. Their per-run summaries survive: `summary_q_.json` was already copied to
  the Mac, and the MiniCPM fork rows above were in the aggregate output. A minimal MiniCPM setup
  was rebuilt (same commit, same data hashes) and these were re-run: the MiniCPM record check and
  forkserver 2x4 (both arms, 3 runs each). The rebuilt directory holds only those outputs. Qwen
  raw data was not regenerated.
- **Shared, loaded machine.** Load average was 15-66 on 32 threads, and other users' jobs ran
  throughout. Memory sums cover only this job's processes and were stable across runs (peak
  spread under 1% for fork, under 6% for forkserver/spawn packmem). Timings are noisy (for
  example, the list arm's 20k DataLoader pass took 35-68 s).
- **Python 3.12 forkserver does not preload `__main__`.** `ForkServer.ensure_running` keeps only the
  `main_path`/`sys_path` keys of `spawn.get_preparation_data()`, which returns
  `init_main_from_path` for a script. The forkserver process stays at 13 MB RSS (checked with a
  standalone test), and every worker re-imports torch, transformers and the training script, as
  with spawn. On Python 3.14, where forkserver is the default, this may behave differently. The
  forkserver numbers here are for 3.12.3. This affects both arms equally (about 0.2 GiB per
  worker).
- **List arm under forkserver/spawn was run at 2x4, not 8x4** (memory cap). The 8x4 figure
  (~117 GiB) is per-rank arithmetic.
- **No images, no model, no GPU.** Real training adds image decoding buffers, CUDA context and
  pinned memory, which are the same in both arms. The savings shown are what packmem changes.
  Absolute totals on a GPU node will be higher.
- `num_workers=4` and `persistent_workers=False` (the HF Trainer defaults the shipped scripts
  use). With persistent workers the forkserver/spawn startup cost is paid once per run, not once
  per epoch.
- The two records with an empty assistant answer make the Qwen stub tokenizer fail. The repo's
  retry loop then sleeps and moves to another index. This happens identically in both arms
  wherever those indices fall in a rank's shard.
- PSS of shared library pages is split with any other process on the box that maps the same file.
  For the venv's torch libraries that is only this job, and for libc the effect is negligible.

## Commands

On the Mac:

```sh
rsync -z .../OpenBMB__MiniCPM-V/data/dl/llava_v1_5_mix665k.json linux-server:packmem-bench/linux-node/data/
scp .../QwenLM__Qwen3-VL*/packmem.v2.patch linux-server:packmem-bench/linux-node/repos/qwen.v2.patch
scp .../OpenBMB__MiniCPM-V/packmem.v2.patch linux-server:packmem-bench/linux-node/repos/minicpm.v2.patch
scp harness/* linux-server:packmem-bench/linux-node/harness/
```

On the server (`L=~/packmem-bench/linux-node`):

```sh
python3 -m venv $L/venv
$L/venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
$L/venv/bin/pip install packmem==0.1.0 psutil numpy transformers pillow torchvision --extra-index-url https://download.pytorch.org/whl/cpu
python3 -m venv $L/venv-mcpm
$L/venv-mcpm/bin/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
DS_BUILD_OPS=0 $L/venv-mcpm/bin/pip install packmem==0.1.0 psutil numpy pillow transformers==4.51.2 deepspeed peft==0.14.0 accelerate==0.30.1

cd $L/repos
git clone --depth 1 https://github.com/QwenLM/Qwen3-VL qwen
git clone --depth 1 https://github.com/OpenBMB/MiniCPM-V minicpm
git -C qwen worktree add -b packmem ../qwen-pm HEAD && git -C qwen-pm apply ../qwen.v2.patch
git -C minicpm worktree add -b packmem ../minicpm-pm HEAD && git -C minicpm-pm apply ../minicpm.v2.patch

systemd-run --user --scope -p MemoryMax=10G -- nice -n 10 \
  $L/venv/bin/python -I $L/harness/convert.py $L/data/llava_v1_5_mix665k.json $L/data/minicpm_665k.json

$L/harness/single.sh            # record digests + pickle size, both Qwen trees
$L/harness/seq_qwen.sh          # all Qwen torchrun runs
$L/harness/seq_mcpm.sh          # all MiniCPM torchrun runs
$L/venv/bin/python -I $L/harness/aggregate.py $L/out q_
$L/venv/bin/python -I $L/harness/aggregate.py $L/out m_
```

One run, as `run.sh` executes it (Qwen, list arm, 8x4 fork, 20k):

```sh
TREE=$L/repos/qwen DATA=$L/data OUT_DIR=$OUT PROBE_DIR=$OUT/probe OMP_NUM_THREADS=1 \
  systemd-run --user --scope -q -p MemoryMax=70G -p MemorySwapMax=0 -- \
  nice -n 10 $L/venv/bin/python -I $L/harness/monitor.py $OUT/monitor.jsonl 0.5 25 -- \
  $L/venv/bin/torchrun --standalone --nproc_per_node=8 \
  $L/harness/qwen_rank.py --samples 20000 --workers 4 --ctx fork
```

(`--samples 0` = whole shard; `run_m.sh` is the same with `venv-mcpm` and `mcpm_rank.py`.)

## Files

On the Mac (`.../scratchpad/linux-node/`): `RESULT.md`, `harness/` (every script used),
`results/summary_q_.json` (all Qwen per-run summaries), `results/single/` (Qwen verify/pickle
JSON), and `results/out-redo/` (raw outputs of the MiniCPM re-run: monitor traces, rank JSON,
probes, logs).

On the server (`~/packmem-bench/linux-node/`, recreated after the deletion): `RESULT.md`,
`harness/`, `out/` (MiniCPM re-run outputs and `aggregate_m.md`). The large inputs, venv and
clones were removed after the run.

Layout as originally produced:

- `harness/`: `qwen_rank.py`, `mcpm_rank.py` (one rank), `qstubs.py`, `mstubs.py` (stubs and
  worker probes), `monitor.py` (smaps_rollup sampler and safety kill), `run.sh`, `run_m.sh`
  (one capped run), `seq_qwen.sh`, `seq_mcpm.sh` (sequences), `qwen_single.py`, `single.sh`
  (verify/pickle), `summarize.py`, `aggregate.py`, `convert.py`.
- `out/<run>/`: `monitor.jsonl` (every sample, every process), `rank*.json`, `probe/`,
  `meta.json` (config, rc, wall time, load averages), logs. `out/summary_q_.json` and
  `out/summary_m_.json` hold all per-run summaries. `out/seq_*.log` is the run log with load
  averages.
- `repos/`: the clones and patched worktrees.
