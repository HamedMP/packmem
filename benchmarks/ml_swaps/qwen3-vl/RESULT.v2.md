# packmem in qwen-vl-finetune (QwenLM/Qwen3-VL): second pass (pickling, spawn workers, repeated epochs)

This pass re-measures `RESULT.md` with the packmem wheel that can pickle a `Table`, with one benchmark process
running at a time. Everything ran locally. Nothing was pushed or posted.

- Commit benchmarked: `96588727e44c78b25ba03ea03b8e12f7e64fd0da`, as in v1. `orig/` is the unpatched worktree; `repo/` has
  the v2 patch applied.
- Wheel: `packmem-0.1.0-cp310-abi3-macosx_11_0_arm64.whl`, sha256 `a258403d...07dde9`, packmem `b421aec`+.
  Installed with `pip install --force-reinstall --no-deps`, then imported once, untimed.
- Machine: Apple M4 Pro (12 cores), 48 GB, macOS 26.6.2, Python 3.13.13, torch 2.15.0, transformers 5.22.2.

## Patch changes (v1 -> v2)

`packmem.v2.patch`: one file, +29 / -12 (v1: +29 / -11). One hunk changed. Sampling with `sampling_rate < 1`
used to draw indices, build a list of the sampled dicts and re-pack it with `packmem.Table(list)`. It now takes
the rows natively:

```python
k = int(len(annotations) * sampling_rate)
if isinstance(annotations, packmem.Table):
    annotations = annotations.take(random.sample(range(len(annotations)), k))
else:
    annotations = random.sample(annotations, k)
```

`random.sample(range(n), k)` draws the same indices, in the same order, as `random.sample(seq, k)` for any
sequence of length n, so the selection is unchanged (hashes below). `random.sample(table, k)` also works now
(Table is a registered `MutableSequence`), but it returns a list of dicts. On the 665k file at 50% that
took 5.2 s and raised the footprint by 3.0 GB, against 1.9 s and +0.1 GB for `take`, so the patch uses `take`.

Not changed:
- The first dataset is still assigned rather than extended into an empty table. Native `extend(Table)` takes 2.7 s
  and one extra packed copy (+350 MB) for 665k rows, while assignment is free. Later datasets still use
  `list_data_dict.extend(annotations)`; that line is unchanged, but it now runs natively instead of
  decoding and re-encoding every row.
- `annotations.lazy()` to set `data_path` (0.5 s for 665k rows). There is no column-assignment API.
- Packing mode stays on lists.

## Method

`harness/v2/bench_v2.py` is `harness/bench.py` with: `main()` under `if __name__ == "__main__"`, so spawn
workers can import it; `MP_CTX=spawn|fork` for the DataLoader; a `pickle` mode; and `harness/v2/wprobe.py`, a
`worker_init_fn` thread that records each worker's own lifetime-peak `phys_footprint`, plus a collate wrapper
that records when a worker finished its first batch. Workload, data and stub processor are unchanged:
real `llava_v1_5_mix665k.json` (665,298 records), `LazySupervisedDataset` from the repository with a
deterministic stub tokenizer and no image decoding, `lengths` and `modality_lengths`, then 20,000 seeded
random indices (or a full shuffled epoch), batch size 4, the repository's collator.

Memory: macOS `phys_footprint`. MB = 10^6 bytes, as in v1. Two totals are reported for parent + 4 workers:

- **peak sum**: the parent's lifetime peak plus each worker's lifetime peak. This is an upper bound on the concurrent
  total. Across repeated runs it varied by less than 0.5%.
- **at 90%**: v1's metric. The parent's and workers' *current* footprints when 90% of the batches had been read.
  macOS compresses cold pages, and the current footprint apparently counts them at their compressed size, so
  this snapshot falls when the OS compresses the parent's idle list. See the epoch tables.

```sh
H=.../bench/QwenLM__Qwen3-VL*/harness/v2
$H/sequence.sh       # waits for load <= 4 (max 10 min), then, each step 'run_all_v2.sh MODE DATASETS RUNS TAG'
                     # = RUNS x {orig, repo} interleaved, fresh '/usr/bin/time -l python -I bench_v2.py <tree> MODE ...':
#   build  llava665k 5 build665k                              (a)
#   MP_CTX=spawn loader llava665k 5 loader665k_spawn          (b)
#   MP_CTX=fork  loader llava665k 5 loader665k_fork           (c)
#   pickle llava665k 1 pickle665k                             (d)
#   build  "llava665k%50,llava150k" 5 buildmix                (the code path v2 changes)
#   N_SAMPLES=10000000 MP_CTX=spawn loader llava665k 3 epoch665k_spawn
#   N_SAMPLES=10000000 MP_CTX=fork  loader llava665k 3 epoch665k_fork
python3 $H/summarize_v2.py build665k loader665k_spawn loader665k_fork pickle665k buildmix epoch665k_spawn epoch665k_fork
```

Timed runs: 16:09:10 to 16:48:26 CET. They started after the 1-minute load fell to 3.85; the coordinator's report
of other CPU-heavy work on this machine covers 15:47-16:06, before this window. Load (1/5/15 min) at each
step boundary, from `harness/v2/load.log` (every run's load is in `out/<tag>/<arm>_<n>.load`):

| step | start | end |
| --- | --- | --- |
| build665k | 3.85 5.78 6.61 | 5.57 5.59 6.34 |
| loader665k_spawn | 5.57 5.59 6.34 | 3.86 4.98 5.79 |
| loader665k_fork | 3.86 4.98 5.79 | 3.51 4.26 5.33 |
| pickle665k | 3.51 4.26 5.33 | 4.11 4.32 5.31 |
| buildmix | 4.11 4.32 5.31 | 2.53 3.59 4.79 |
| epoch665k_spawn | 2.53 3.59 4.79 | 6.56 5.60 5.22 |
| epoch665k_fork | 6.56 5.60 5.22 | 7.35 6.13 5.57 |

## Results

### (a) Main process only, 20k samples, no workers (median of 5)

| | Original | packmem | |
| --- | --- | --- | --- |
| Peak footprint (`time -l`) | 5,238 MB | 729 MB | 7.2x lower |
| Max RSS | 5,286 MB | 866 MB | |
| Footprint after build | 5,203 MB | 627 MB | |
| Dataset build | 2.7 s | 8.1 s | 3x slower |
| `lengths` / `modality_lengths` | 2.3 / 2.2 s | 5.1 / 5.1 s | 2.3x slower |
| 20k `__getitem__` + collate | 5.1 s | 5.3 s | same |
| Wall time | 16.6 s | 24.6 s | +8 s |

v1: 5,239 / 730 MB. Same.

### (b) 4 workers, spawn, 20k samples (median of 5; new, did not work in v1)

| | Original | packmem | |
| --- | --- | --- | --- |
| Parent peak footprint | 8,958 MB | 2,255 MB | |
| Each worker's peak | 3,430-3,436 MB | 812-813 MB | 4.2x lower |
| Sum of 4 workers' peaks | 13,730 MB | 3,247 MB | |
| **Parent + 4 workers, peak sum** | **22,687 MB** | **5,503 MB** | **4.1x lower** |
| Parent + 4 workers, at 90% | 22,686 MB | 5,501 MB | |
| Worker start to first batch, by worker | 3.1 / 8.4 / 14.4 / 20.4 s | 1.0 / 2.0 / 3.1 / 4.2 s | |
| `iter(dl)` to first batch | 24.6 s | 4.5 s | 5.5x faster |
| `iter(dl)` to last batch | 31.3 s | 6.6 s | |
| Wall time (includes ~20 s worker shutdown, see caveats) | 63.3 s | 46.1 s | |

### (c) 4 workers, fork, 20k samples (median of 5)

| | Original | packmem | |
| --- | --- | --- | --- |
| Parent peak footprint | 5,238 MB | 724 MB | |
| Each worker's peak | 473-513 MB | 131-137 MB | |
| Sum of 4 workers' peaks | 2,030 MB | 531 MB | |
| **Parent + 4 workers, peak sum** | **7,270 MB** | **1,255 MB** | **5.8x lower** |
| Parent + 4 workers, at 90% (v1 metric) | 7,131 MB | 1,224 MB | v1: 7,131 / 1,213 |
| Worker start to first batch | 0.02-0.04 s | 0.02-0.03 s | |
| `iter(dl)` to last batch | 2.09 s | 1.94 s | |
| Wall time | 13.2 s | 20.6 s | +7.4 s (build and lengths) |

### (d) Pickled size of the dataset, `len(pickle.dumps(LazySupervisedDataset))`

| | Original | packmem |
| --- | --- | --- |
| Pickled size | 689,756,296 B (690 MB) | 309,230,281 B (309 MB) |
| `Table.nbytes` | n/a | 311 MB |
| `pickle.dumps`, 3 runs | 3.61 / 3.42 / 3.46 s | 0.15 / 0.14 / 0.14 s |
| `pickle.loads` | 1.37 s | 0.04 s |
| Round trip equals the original, every row | yes | yes |

### Full shuffled epoch, 665,298 samples, 4 workers (3 runs per arm and start method)

v1 had one run per arm, fork only: 16,383 MB vs 2,189 MB at 90%.

**fork**

| | Original | packmem | |
| --- | --- | --- | --- |
| Each worker at 10 / 50 / 90% (current) | 1,184 / 2,418 / 2,783 MB | 260 / 377 / 397 MB | v1: 1,185 / 2,419 / 2,783 and 255 / 372 / 393 |
| Each worker's peak | 2,829-2,837 MB | 397-403 MB | 7.0x lower |
| Parent peak | 5,248 MB | 726 MB | |
| **Parent + 4 workers, peak sum** (3 runs) | **16,577 MB** (16,578 / 16,575 / 16,577) | **2,328 MB** (2,328 / 2,315 / 2,329) | **7.1x lower** |
| Parent + 4 workers, at 90% (3 runs) | 14,308 / 14,313 / 14,320 MB | 2,190 / 2,181 / 2,201 MB | 6.5x lower |
| `iter(dl)` to last batch | 65.8 / 68.3 / 67.9 s | 66.7 / 66.2 / 71.3 s | same |
| Wall time | 79.0 s | 85.5 s | +6.5 s (build and lengths) |

The workers grow exactly as in v1. The at-90% total for the original is lower than v1's 16,383 MB because the
parent's current footprint at that moment was 3,181 MB instead of about 5,250 MB: macOS had compressed the
parent's idle list. Its RSS was 3.2 GB as well. The peak sum does not depend on compression timing, so it is
the figure to use.

**spawn**

| | Original | packmem | |
| --- | --- | --- | --- |
| Each worker's peak | 3,431-3,439 MB | 816-818 MB | 4.2x lower |
| Each worker at 50% / 90% | 3,431 / 3,432 MB | 507 / 508 MB | |
| Parent peak | 9,766 MB | 2,266 MB | |
| **Parent + 4 workers, peak sum** (3 runs) | **23,506 MB** (23,486 / 23,550 / 23,506) | **5,533 MB** (5,532 / 5,534 / 5,526) | **4.2x lower** |
| Parent + 4 workers, at 90% (3 runs) | 18,922 / 17,543 / 23,502 MB | 2,560 / 2,637 / 2,560 MB | |
| `iter(dl)` to first batch | 22.9 s | 4.1 s | |
| `iter(dl)` to last batch | 91.1 / 93.6 / 93.1 s | 68.6 / 69.2 / 71.2 s | |
| Wall time | 124.8 s | 108.3 s | |

With spawn, each worker holds a full private copy from the start: about 3.4 GB of dicts with the list,
and about 0.5 GB with packmem (interpreter, torch, the 309 MB table). It does not grow during the epoch.
In the original arm the machine ran out of free memory: swap use reached 3.7 GB, and the parent's RSS fell to
about 100 MB at 90%. That explains the scatter of its at-90% totals and makes its timings pessimistic.

### Two datasets with 50% sampling (`llava665k%50,llava150k`, 482,649 records), the path v2 changes

| | Original | packmem v1 (from RESULT.md) | packmem v2 |
| --- | --- | --- | --- |
| Peak footprint | 5,639 MB | 2,202 MB | 908 MB |
| Footprint after build | 5,625 MB | 633 MB | 880 MB |
| Dataset build | 3.2 s | 17.9 s | 11.8 s |
| Wall time | 15.6 s | 34.7 s | 24.8 s |

The v1 peak came from the temporary list of sampled dicts, which `take` removes. The settled footprint is
higher than in v1 (880 vs 633 MB). The cause was not investigated.

## Identical output

- `verify` mode (SHA-256 over every row of `list_data_dict`, `json.dumps(sort_keys=True)`), original against v2,
  each in a fresh process (`harness/v2/verify/`): JSON file `7357e4d6fdc54be3...` for both; JSONL file the same hash;
  `llava665k%50,llava150k` (the `take`-based sampling path changed in v2) `ec58b9064ff2ef15...` for both, the same as
  v1; `data_packing=True` (unchanged list path) the same hash for both. All match v1.
- `lengths` and `modality_lengths`: `348d788a1e...` in every run of every configuration, both arms (as in v1).
- Collated `input_ids`, `labels`, `position_ids`: `3c98d76114...` for the 20k indices in all 30 single-dataset runs
  (build, spawn and fork; both arms), and `93fd1a67ea...` for the mixed config. Full epoch: `62f908d745...` in all 12
  epoch runs (spawn and fork, both arms). All hashes are the same as in v1, so spawn workers produce exactly the
  batches that fork workers do.
- `pickle` mode: every row of the unpickled dataset equals the original, in both arms.

## Caveats, and where packmem is slower

- **Startup is slower**: dataset build 2.7 s -> 8.1 s, and `lengths` / `modality_lengths` each about 2.3x slower
  (2.2 s -> 5.1 s). Together that is about 8 s more per rank, once per run. With fork the end-to-end wall time
  is longer with packmem (13.2 -> 20.6 s for 20k samples, 79 -> 85.5 s for an epoch).
- **The spawn parent's peak is about 1.5 GB higher than it needs to be.** Each `pickle.dumps(table)` /
  `Table.to_bytes()` leaves about one packed size (about 300 MB) of freed memory that macOS reclaims only
  later. With 4 workers the parent's peak is 2.26 GB instead of about 0.73 GB. By 90% of a 70-second
  epoch it was back to 528-605 MB, but in a 6-second 20k run it was still 2.25 GB at 90%. Reproduced in
  isolation in the MiniCPM-V notes. The pickled payload itself is the packed size.
- **Spawn startup is serial in both arms**: the parent sends one pickled copy per worker. With packmem the
  first batch arrives after 4.1-4.5 s, against 23-25 s with the list, and 0.1 s with fork.
- **Worker shutdown under spawn takes about 20 s** after the last batch in both arms (torch's 5 s join timeout
  x 4 workers). A plain-list DataLoader does the same on this machine. Tables report time to the last batch;
  wall times include the shutdown.
- `random.sample(table, k)` works, but it decodes every sampled row into a dict. `take` is the right call for
  large k.
- Key order of returned dicts for text-only records differs, as noted in v1.
- The stub processor does no image decoding and has no model. The measurements cover host RAM for annotations
  only.
- macOS `phys_footprint` is used as a stand-in for Linux USS/PSS. Nothing was measured on Linux. Under spawn, the
  original arm pushed this 48 GB machine into swap.

## Files

- `packmem.v2.patch`; `packmem.patch` unchanged.
- `harness/v2/bench_v2.py`, `wprobe.py`, `run_all_v2.sh`, `sequence.sh`, `summarize_v2.py`
- `harness/v2/out/<tag>/{orig,repo}_<n>.{json,time,load,log}`, `harness/v2/load.log`
