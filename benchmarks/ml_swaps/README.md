# ML fine-tuning data pipelines: list of dicts vs packmem

Real data in every run: `llava_v1_5_mix665k.json` (665,298 records, 1.03 GB) from
`liuhaotian/LLaVA-Instruct-150K`. Each repository's own dataset class is used, with a stub
tokenizer/processor and no image decoding, so these figures cover host RAM for the annotations only.
No model or GPU was involved. None of the three repositories has upstream tests covering the
patched code. Correctness is instead checked as follows: every record deep-equals `json.load`'s
output, and collated batch hashes are identical between arms.

**Status: indicative.** The patches, harness scripts and raw outputs are in this directory. The
datasets, the upstream clones and the environments are not: each `RESULT` file names the upstream
commit and the commands. The Linux runs' raw traces were lost when their working directory on the
server was removed during unrelated clean-up, so for those only the per-run summaries remain, and
batch equality for ranks 3 to 7 of the 8x4 fork runs is not confirmed (see `linux-node/RESULT.md`).
The patches are diffs of Apache-2.0 projects: QwenLM/Qwen3-VL, OpenBMB/MiniCPM-V and
LLaVA-VL/LLaVA-NeXT.

Patches: `packmem.v2.patch` in each `bench/<repo>/` directory. Wheel: packmem 0.1.0 at `b421aec`
or later (sha256 `a258403d…07dde9` on macOS; the PyPI manylinux2014 x86_64 wheel on Linux).

## macOS: Apple M4 Pro, 48 GB, macOS 26.6.2, Python 3.13.13, torch 2.15.0

Metric: macOS `phys_footprint`. "Peak sum" is the parent's lifetime peak plus each worker's
lifetime peak. Runs are sequential and interleaved; timed windows started at 1-minute load ≤ 4.
Per-run load averages are in each `RESULT.v2.md`.

### Qwen3-VL `qwen-vl-finetune` (commit 9658872), MB = 10^6 bytes

| | List | packmem | |
|---|---|---|---|
| Main process only, peak | 5,238 | 729 | 7.2x |
| Dataset build | 2.7 s | 8.1 s | 3.0x slower |
| `lengths` / `modality_lengths` | 2.3 / 2.2 s | 5.1 / 5.1 s | about 2.3x slower |
| **Full shuffled epoch, 4 fork workers, peak sum (3 runs)** | **16,577** (16,578 / 16,575 / 16,577) | **2,328** (2,328 / 2,315 / 2,329) | **7.1x** |
| Epoch, fork, each worker's peak | 2,829-2,837 | 397-403 | |
| **Full shuffled epoch, 4 spawn workers, peak sum (3 runs)** | **23,506** (23,486 / 23,550 / 23,506) | **5,533** (5,532 / 5,534 / 5,526) | **4.2x** |
| Epoch, spawn, each worker's peak | 3,431-3,439 | 816-818 | |
| Spawn: `iter(dl)` to first batch | 22.9 s | 4.1 s | |
| Pickled dataset | 690 MB | 309 MB | |
| `pickle.dumps` / `loads` | 3.5 / 1.37 s | 0.15 / 0.04 s | |
| Mixed config `llava665k%50,llava150k`: peak / build | 5,639 / 3.2 s | 908 / 11.8 s | |

In the spawn list arm the machine went into swap (3.7 GB), which makes that arm's timings pessimistic.

### MiniCPM-V (commit 4dbbb6c5), MiB

| | List | packmem | |
|---|---|---|---|
| workers=0, peak footprint | 5,266 | 803 | 6.6x |
| Dataset build | 3.5 s | 8.0 s | |
| 4 spawn workers, 20k samples: parent + 4 | 23,514 | 5,997 | 3.9x |
| Spawn: each worker | 3,461-3,472 | 924-937 | |
| Spawn: first batch | 25.3 s | 6.0 s | |
| 4 fork workers, 20k samples: parent + 4 | 7,370 | 1,486 | 5.0x |
| Pickled size | 671.4 MiB | 301.2 MiB (= `nbytes`) | |
| `dumps` / `loads` | 3.3 / 1.39 s | 0.14 / 0.03 s | |

### LLaVA-NeXT, MiB (synthetic 985k-record LLaVA-format mix, see RESULT.md v1)

| | List | packmem | |
|---|---|---|---|
| Peak footprint | 5,188 | 1,818 | 2.9x |
| Construction | 5.3 s | 23.1 s | 4.4x slower |
| 4 spawn workers: parent + 4 | 28,584 | 10,588 | 2.7x |
| 4 fork workers, 20k: parent + 4 | 7,212 | 2,374 | 3.0x |
| Pickled size | 1,372 MiB | 682.7 MiB | |

## Linux: one 8-rank node on linux-server (AMD Ryzen 9 7950X3D, 124 GiB, Ubuntu 24.04.5, Python 3.12.3)

Setup: `torchrun --standalone`, gloo, `DistributedSampler(num_replicas=8)`, DataLoader with 4 workers. PSS is
summed over every process every 0.5 s from `/proc/<pid>/smaps_rollup`. Medians of 3 runs unless noted.
The box was shared (load 15-92), so timings are noisy. Memory spread under fork was under 1%.

| Repo | Start method | Ranks x workers | Samples/rank | List peak GiB | packmem peak GiB |
|---|---|---|---|---|---|
| Qwen3-VL | fork | 8x4 | 20k | **47.73** | **4.86** |
| Qwen3-VL | fork | 8x4 | full shard 83,163 (1 run) | 54.69 | 6.55 |
| Qwen3-VL | forkserver | 2x4 | 20k | 29.41 | 5.13 |
| Qwen3-VL | spawn | 2x4 | 20k | 29.84 | 4.96 |
| Qwen3-VL | forkserver / spawn | 8x4 | 20k | not run (cap) | 19.94 / 19.62 |
| MiniCPM-V | fork | 8x4 | 20k | 37.89 | 7.13 |
| MiniCPM-V | forkserver | 2x4 | 20k | 31.57 | 6.41 |

The list arms under forkserver and spawn were run at 2x4 because 8x4 would exceed the 60 GB safety cap
(about 15 GiB per rank plus its workers). Under forkserver/spawn each packmem worker holds its own copy
(about 0.3 GiB); only fork shares it. With Python 3.12, forkserver does not preload `__main__`, so every
worker re-imports torch.

## Known costs and caveats

- Dataset build is 2-4x slower; the nested `conversations` column is stored as JSON text.
- Under spawn on macOS, the parent's peak is about 1.5 GB above live use, because macOS keeps freed
  pickle buffers. Partly fixed in 694c651; not re-measured. glibc returns large blocks, so this is
  probably macOS-only.
- Every result covers annotations only: no images, no model, no GPU.
