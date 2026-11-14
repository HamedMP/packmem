# packmem `Table.share()` in Qwen3-VL's fine-tuning dataset, 4 spawn DataLoader workers (macOS)

> **Measured on the pre-release zero-copy branch, not on the published 0.2.0.** Mac: branch `wip/zero-copy-v2` at 3fa7264 (wheel f9f57281…) for "share v2"/"open v2"; Linux: 3fa7264 (wheel ea2962bf…) and 7de0b93 (v2b, wheel 8cf7725a…). Loader figures are one training process's data loader with 4 workers, annotations only, no model and no GPU — not "per GPU node". The 22.7 GB list figure is the list arm of the 20k-sample spawn run.


Everything ran locally and serially. Nothing was committed, pushed or posted, and `$PACKMEM`
was only read.

- Upstream: QwenLM/Qwen3-VL `96588727e44c78b25ba03ea03b8e12f7e64fd0da`, as in v1/v2. Three git worktrees:
  `orig/` (unpatched), `repo/` (`packmem.v3.patch`), `repo-share/` (`packmem.v3.patch` + `share.patch`).
- Wheel for every share() measurement: `packmem-0.1.1-cp310-abi3-macosx_11_0_arm64.whl`, sha256
  `f34d69df52486e3895571667cff75f2e2fa46967b8714580ff2a8c05bfd57cbd` (the rebuild with the 0600 file mode; the
  9b58a824... build was never copied or installed). Copied to `wheel/`, installed with
  `pip install --force-reinstall --no-deps`, imported once untimed. Its `packmem/__init__.py` is identical to the
  source tree's at the time.
- Machine: Apple M4 Pro (12 cores), 48 GB, macOS 26.6.2 (25G83). Python 3.13.13 (Homebrew), torch 2.15.0,
  transformers 5.22.2, psutil 7.2.2, numpy 2.5.4. Same versions as v2 except the packmem wheel.
- Data: `llava_v1_5_mix665k.json` from the `liuhaotian/LLaVA-Instruct-150K` dataset repository, 1,029,887,963 bytes,
  sha256 `ce959ce6e23073ee1cd1a8a2ef1c633768c10d4174327b8b2dc7113b91af6cf8`, 665,298 records. Its row hash
  (`verify` mode) is `7357e4d6fdc54be3...` in all three arms, the same as v2, so it is the same data.

## Patches

`packmem.v3.patch` (repo vs orig): +29 / -13, one file. It is `packmem.v2.patch` with one change. The data_path loop
over lazy rows

```python
for ann in annotations.lazy():
    ann["data_path"] = data["data_path"]
```

becomes `annotations.set_column("data_path", data["data_path"])`. Rows are identical (row hash above, batch hashes
below).

`share.patch` (repo-share vs repo): +3 lines, just before `self.list_data_dict = list_data_dict`, after every dataset
is loaded, sampled, given its data_path and extended:

```python
if isinstance(list_data_dict, packmem.Table):
    list_data_dict.share()
```

The dataset object keeps the table alive for the whole run, so the file lives as long as the DataLoader needs it.

## Method

`harness/v3/bench_v3.py` is `ml_swaps_bundle/qwen3-vl/harness/v2/bench_v2.py` with workload, sampling, batch size (4),
collator and hashing unchanged. Added: the .pkm path/size/mode after the build; whether the .pkm still exists after
the last batch; `hash` mode (the same sampler, batch size and collator with `num_workers=0`); in `pickle` mode, the
table's own pickled size plus read-only and file-lifetime checks; and `DIAG=1`, which runs `footprint -p` and
`vmmap -summary` on the parent and every worker at the 50% batch. `wprobe.py` additionally records each worker's
footprint and RSS at `worker_init_fn`, which runs right after the dataset has been unpickled.

`harness/v3/run_all_v3.sh MODE DATASETS RUNS TAG ARM...` starts one fresh `/usr/bin/time -l python -I bench_v3.py`
per run and arm. Arm order is reversed on even runs. Before every run it waits for the 1-minute load to fall to 4 or
below, for at most 10 minutes (`wait_load.sh`). It records load and free memory before and load after each run
(`out/<tag>/<arm>_<n>.load`), and any `packmem-<pid>-*.pkm` the process left behind (`.pkmleft`).
`harness/v3/sequence_v3.sh` ran, in order:

```sh
H=$WORK/harness/v3
$H/run_all_v3.sh verify llava665k 1 verify665k orig repo repo-share
$H/run_all_v3.sh hash llava665k 1 hash20k orig
N_SAMPLES=10000000 $H/run_all_v3.sh hash llava665k 1 hashepoch orig
$H/run_all_v3.sh pickle llava665k 1 pickle665k orig repo repo-share
MP_CTX=spawn $H/run_all_v3.sh loader llava665k 3 A_spawn20k repo repo-share                        # A
N_SAMPLES=10000000 MP_CTX=spawn $H/run_all_v3.sh loader llava665k 3 B_epoch_spawn repo repo-share   # B
DIAG=1 MP_CTX=spawn $H/run_all_v3.sh loader llava665k 1 diag_spawn20k repo repo-share              # untimed
python3 $H/summarize_v3.py A_spawn20k B_epoch_spawn pickle665k
$H/../../venv/bin/python -I $H/mapprobe.py parent <data>/llava_v1_5_mix665k.json $H/out/mapprobe      # untimed
```

Memory is macOS `phys_footprint`, in MB = 10^6 bytes, as in v2. Parent peak is `time -l`'s "peak memory
footprint". A worker's peak is its own lifetime-peak `phys_footprint`, from wprobe (MiB converted to MB). The peak
sum is the parent's peak plus the four workers' peaks, an upper bound on the concurrent total.

### Why orig is not re-run under spawn

Before A and B the sequence measured free + inactive + speculative + purgeable memory: 20.2 GB and 19.9 GB, with 3.0 of
4.0 GB swap already in use by other applications. v2 measured a 23.5 GB peak sum for the orig spawn epoch, so it
does not fit. **The orig columns below are v2's numbers** (same commit, machine, Python, torch and transformers;
v2 ran on 2026-11-13 16:09-16:48). Orig's batches were still hashed in this session, with `hash` mode
(`num_workers=0`, about 5 GB).

### Load

Timed window: 21:15 to 22:11 CET. Other applications (WindowServer, Chrome, Codex, Dia, Beeper) kept the 1-minute load
near 4-5 the whole time. Every A run started at load ≤ 4.00. In B, three of six runs hit the 10-minute cap and started
anyway: repo-share_1 at 5.33, repo_2 at 5.02 and repo-share_3 at 5.34. That affects B's timings, not its memory (spread
under 0.2%). Per-run loads, 1/5/15 min:

| run | A start | A end | B start | B end |
| --- | --- | --- | --- | --- |
| repo_1 | 3.94 4.60 4.88 | 4.46 4.68 4.90 | 4.00 4.40 4.66 | 6.58 5.30 4.98 |
| repo-share_1 | 3.94 4.60 4.85 | 3.74 4.48 4.79 | **5.33** 5.43 5.19 | 5.33 5.46 5.23 |
| repo-share_2 | 3.74 4.48 4.79 | 3.97 4.46 4.77 | 3.99 5.11 5.11 | 5.34 5.33 5.20 |
| repo_2 | 3.97 4.46 4.77 | 4.72 4.60 4.80 | **5.02** 5.04 5.09 | 5.98 5.52 5.28 |
| repo_3 | 4.00 4.46 4.74 | 4.59 4.53 4.75 | 3.84 4.88 5.06 | 6.28 5.52 5.29 |
| repo-share_3 | 3.88 4.38 4.69 | 4.61 4.54 4.73 | **5.34** 7.90 7.16 | 6.38 7.68 7.17 |

## Results

### A. 4 spawn workers, 20,000 seeded random indices (median of 3)

| | orig (v2) | repo (packmem, plain pickle) | repo-share (packmem, share()) |
| --- | --- | --- | --- |
| Parent peak footprint | 8,958 MB | 1,314 MB (1,314 / 1,311 / 1,317) | **725 MB** (727 / 725 / 724) |
| Each worker's lifetime peak | 3,430-3,436 MB | 805-806 MB | **497-498 MB** |
| Each worker after unpickling (worker_init) | n/a | 801-802 MB | 493-494 MB |
| Each worker at 90%: footprint / RSS | n/a | 805-806 / 860-861 MB | 496-498 / 551-553 MB |
| **Parent + 4 workers, peak sum** | **22,687 MB** | **4,535 MB** (4,535 / 4,533 / 4,540) | **2,715 MB** (2,716 / 2,715 / 2,713) |
| Worker start to first batch, workers 0-3 | 3.1 / 8.4 / 14.4 / 20.4 s | 3.91 / 2.91 / 1.92 / 1.01 s | 1.07 / 1.06 / 1.06 / 1.05 s |
| Worker processes created after `iter(dl)` | serial | 0.05 / 1.06 / 2.05 / 3.03 s | 0.015 / 0.022 / 0.028 / 0.035 s |
| `iter(dl)` to first batch | 24.6 s | 4.06 s (4.20 / 4.04 / 4.06) | **1.17 s** (1.15 / 1.18 / 1.17) |
| `iter(dl)` to last batch | 31.3 s | 6.02 s (7.34 / 6.01 / 6.02) | **3.12 s** (3.07 / 3.17 / 3.12) |
| Wall time (includes ~20 s worker shutdown + 8 s build + 10 s lengths) | 63.3 s | 45.2 s | 42.5 s |

### B. 4 spawn workers, one full shuffled epoch, 665,298 samples (median of 3)

| | orig (v2) | repo | repo-share |
| --- | --- | --- | --- |
| Parent peak footprint | 9,766 MB | 1,328 MB (1,326 / 1,328 / 1,329) | **725 MB** (725 / 725 / 726) |
| Each worker's lifetime peak | 3,431-3,439 MB | 809-814 MB | **502-507 MB** |
| Each worker at 10% / 50% of the epoch | 3,431 MB | 808-811 / 809-812 MB | 501-502 / 502-503 MB |
| Each worker at 90% | 3,432 MB | 811-813 (run 1); 501-505 (runs 2, 3) | 502-506 MB |
| **Parent + 4 workers, peak sum** | **23,506 MB** | **4,571 MB** (4,574 / 4,570 / 4,571) | **2,741 MB** (2,739 / 2,741 / 2,741) |
| Worker start to first batch, workers 0-3 | n/a | 3.90 / 2.89 / 1.92 / 1.00 s | 2.74 / 2.73 / 2.73 / 2.72 s |
| `iter(dl)` to first batch | 22.9 s | 4.05 s (4.03 / 4.78 / 4.05) | 2.87 s (3.02 / 1.86 / 2.87) |
| `iter(dl)` to last batch | 91.1 / 93.6 / 93.1 s (swapping) | 79.4 s (77.0 / 83.4 / 79.4) | 74.5 s (75.7 / 74.5 / 73.3) |
| Wall time | 124.8 s | 119.6 s | 114.6 s |

In B, repo-share's time to first batch follows the load at its start: 1.86 s at 3.99, and 2.87 / 3.02 s at 5.33-5.34.
A, where every run started at ≤ 4, gives 1.15-1.18 s. The 5 s difference in time to last batch is within what the
load explains; three B runs started above 5. I would not claim a throughput change.

### Pickle size and the shared file (`pickle` mode, one run per arm)

| | orig | repo | repo-share |
| --- | --- | --- | --- |
| `len(pickle.dumps(dataset))` | 689,756,296 B | 307,625,915 B | **913 B** |
| `len(pickle.dumps(dataset.list_data_dict))` | 689,755,524 B | 307,625,143 B | **141 B** |
| `pickle.dumps(dataset)`, 3 runs | 4.20 / 3.80 / 3.86 s | 0.040 / 0.046 / 0.082 s | 0.000 s |
| `pickle.loads` (same process) | 1.72 s | 0.041 s | 0.049 s |
| Round trip equals the original, every row | yes | yes | yes |
| `share()` call (after an `unshare()`) | | | 0.16 s |

- `.pkm` location: `$TMPDIR` = `$TMPDIR/packmem-<pid>-<16 hex>.pkm` (macOS has no
  /dev/shm). This is a normal file on the APFS system volume, not RAM-backed: share() writes 308 MB to disk once.
- Size 307,625,077 bytes in every run, equal to the `size` recorded in the pickle. `Table.nbytes` is 307,633,620.
- Mode `-rw-------` (`stat.filemode`, equivalent to `stat -f %Sp`), checked while each run held it: every A, B and pickle
  run, and the smoke tests.
- The 913-byte dataset pickle is the 141-byte table pointer plus the stub processor, data args and other attributes.

### What the shared file counts as, and what a worker holds (`out/mapprobe/`, `out/diag_spawn20k/`)

`mapprobe.py` unpickles the 665k table in fresh processes (bytes read from a file, as a spawn worker reads them from
its pipe), and in a third process maps the .pkm read-only with Python's `mmap` and reads every page:

| fresh process | phys_footprint | RSS | `footprint` / `vmmap` |
| --- | --- | --- | --- |
| plain pickle (307.6 MB) read, then `loads` | 15 -> 324 -> 943 MB; still 943 after dropping the bytes | 952 MB | 899 MiB dirty |
| shared pickle (141 B) `loads` | 15 -> 328 MB (peak 328) | 337 MB | 312 MiB dirty, "mapped file" 0 |
| .pkm mapped read-only, every page read | 16.1 MB | 25 -> 333 MB | "mapped file": 0 dirty, 293 MiB clean; vmmap: 293.4M resident, 0K dirty |

So a read-only file mapping is clean, file-backed page cache. macOS counts it in RSS, but not in `phys_footprint`,
`footprint`'s dirty column or vmmap's dirty column. It is shared with every process that maps the file and can be
dropped by the OS at any time. A worker built from the file has a footprint of exactly the private copy (about 312 MiB
of dirty malloc memory). The mapping itself never shows up in its footprint, and it is gone afterwards: at the 50%
batch, `footprint` shows a "mapped file" of 0 B in every worker of both arms.

`footprint` / `vmmap -summary` at the 50% batch (`DIAG=1`, A config, MiB):

| | repo parent | repo worker | repo-share parent | repo-share worker |
| --- | --- | --- | --- | --- |
| phys_footprint | 1,259 | 767 | 666 | 474 |
| `MALLOC_LARGE` (live: the table) | 278.7 | 274.8 | 278.7 | 274.8 |
| `MALLOC_LARGE (empty)` (freed, still resident) | **700.8** | **293.4** | 114.0 | **none** |
| `MALLOC_SMALL` | 182.0 | 120.9 | 158.6 | 121.3 |

Each repo worker holds the same live table as a repo-share worker, plus 293.4 MiB (= 307.6 MB) of `MALLOC_LARGE (empty)`:
the received pickle payload, freed but still resident. The repo parent likewise keeps 700.8 MiB of freed pickle
buffers from serialising the table four times. With share() these are gone. Python heap, torch and interpreter are
the same.

## What share() changes, and what it does not

Changes:
- **Pickled dataset: 307.6 MB -> 913 B.** The parent writes the table once (0.16 s, 308 MB to $TMPDIR) instead of
  serialising it once per worker.
- **Workers start in parallel.** With a plain pickle the parent writes 308 MB into each worker's pipe in turn. Workers
  are created about 1 s apart and the last one starts work after about 3 s; the first batch arrives after 4.06 s.
  With share() all four exist within 35 ms, and the first batch arrives after 1.17 s (A; 1.86-3.02 s in B under
  higher load). Against v2's list-of-dicts it is 24.6 s -> 1.17 s.
- **Peak memory**: workers 805 -> 497 MB each, parent 1,314 -> 725 MB, so the peak sum goes from 4,535 to 2,715 MB in A
  and from 4,571 to 2,741 MB in B (-40%). Against v2's orig list arm: 22,687 -> 2,715 MB (8.4x) and 23,506 -> 2,741 MB
  (8.6x).

Does not change:
- **Each worker still holds a private copy of the packed table**, about 308 MB (312 MiB dirty in `footprint`). Of a
  share worker's 497 MB, roughly 185 MB is interpreter, torch and the dataset module and the rest is the table. Four
  workers therefore still hold four copies (about 1.2 GB), plus the parent's own.
- **Steady-state memory over a long run.** The memory share() saves in a worker is the freed pickle buffer, not
  live data. In B, macOS released it in the repo workers by 90% of the epoch in two of three runs: 501-505 MB, the
  same as repo-share. At the end of every B run both arms' workers were at about 479 MiB. So on macOS share() lowers
  the peak and the first 40-60 s, not the plateau. On Linux, glibc returns large freed blocks to the OS
  immediately, so the peak saving there is probably smaller (not measured). The startup and pickle-size gains are
  independent of the allocator.
- **Throughput**: per-batch work is the same. B's time to last batch differs by 5 s (79.4 vs 74.5) but three runs started
  above load 5. Not a claimed effect.
- **The parent's own table**: unchanged (725 MB peak, about the same as `num_workers=0`).

## Correctness

| check | orig | repo | repo-share | v2 |
| --- | --- | --- | --- | --- |
| Row hash, all 665,298 rows, sorted keys (`verify`) | `7357e4d6fdc54be3` | `7357e4d6fdc54be3` | `7357e4d6fdc54be3` | `7357e4d6fdc54be3` |
| `lengths` + `modality_lengths` | (as v2) | `348d788a1e` in all 6 A + 6 B runs | `348d788a1e` in all 6 A + 6 B runs | `348d788a1e` |
| Batches, 20k indices (A) | `3c98d761142c9abb` (`hash` mode) | `3c98d76114` in 3/3 | `3c98d76114` in 3/3 | `3c98d76114` |
| Batches, full epoch (B) | `62f908d745c4ddd3` (`hash` mode) | `62f908d745` in 3/3 | `62f908d745` in 3/3 | `62f908d745` |
| Pickle round trip, every row equal | yes | yes | yes | yes |

The harness's workload is unchanged from v2, and every hash equals v2's. That includes orig through
`num_workers=0`, so the in-process loader and the spawn workers produce the same batches.

## Bugs and surprises

- **No TypeError anywhere in Qwen's code path.** `__getitem__` -> `_get_item` reads `self.list_data_dict[i]`, which
  returns a fresh dict, and never writes to the table. `lengths`, `modality_lengths` and the 3 x 665k-sample epochs in
  the spawn workers ran without an exception. The only write, data_path, happens before `share()`.
- Read-only behaviour (`pickle` mode, on the parent's shared table and on an attached copy): `t[0] = row`, `append`,
  `set_column`, and writing through a lazy row (`next(t.lazy())["data_path"] = "x"`) each raise
  `TypeError: this table is shared read-only; call unshare() on the original, or copy() it, to change it`.
  `t[0]["data_path"] = "x"` succeeds but only changes the returned dict: the table is unchanged, as with any Table.
  `copy()` gives a writable table (`shared == False`, append works). `unshare()` (0.012 s) removes the file and makes
  the table writable again.
- **Error message nit:** calling `share()` on a table unpickled from a shared file *in the same process* says "this table was
  loaded from another process's shared file; copy() it first". The process is the same one here. Harmless.
- **File lifetime**: every A/B run reported the .pkm still present after the last batch, and no process left a
  `packmem-<pid>-*.pkm` behind after a normal exit (`.pkmleft` empty for all 22 runs plus smoke tests). After `del` of the
  dataset plus `gc.collect()` the file is gone at once. A pickle made earlier then fails with a clear
  `FileNotFoundError: shared packmem table ... is gone: the table that shared it was closed or its process ended`.
- **Stale files**: none found. `cleanup_stale()` at the end removed 0 files, and `$TMPDIR` had no `packmem-*.pkm`
  (see "Cleanup check" below).
- **Not a bug, but worth knowing on macOS:** without /dev/shm the file lives on disk in `$TMPDIR`, which is per-user
  and swept by the OS only after days. A crashed trainer leaves 308 MB there until `cleanup_stale()` runs.
- Observation: with share(), all four workers reach `worker_init_fn` at the same moment, to the millisecond (for
  example 1.068 s in all four), although they were created 7 ms apart. Not investigated.

## Cleanup check (share() runs)

`packmem.cleanup_stale()` (candidate wheel, after all runs): removed 0. `$TMPDIR` holds no `*.pkm`. All 62 `.pkmleft`
records (every bench run in this work dir) are empty.

---

# 0.1.2 gate: dataset build time and memory, list / packmem 0.1.1 (PyPI) / candidate

Wheels (each copied into this work dir, hash checked before installing):

| arm | wheel | sha256 |
| --- | --- | --- |
| list (orig) | none | |
| 0.1.1 (PyPI) | `pip download packmem==0.1.1 --no-deps --platform macosx_11_0_arm64 --only-binary=:all:` -> `wheel-pypi/` | `e705bd7b5d2483e9743dd61cf41fb37796f9df229d1ce7869cfed1bf52e611c2` |
| **candidate** (d81ad22, background packing opt-in) | `wheel-cand/` | `630df090cc42347ccab82446276841fd93518c9a4bf7cf64c1b5eb1e67dbf9cc` |
| superseded candidate (a78832a, background packing on by default) | deleted after use | `75dbc431b9738cfe559f282e1301fcae54287aa767d35ac3529ab9ae1f58ae00` |
| share() runs above | `wheel/` | `f34d69df52486e3895571667cff75f2e2fa46967b8714580ff2a8c05bfd57cbd` |

A copy with sha256 `db12cb13...` (python/dist built from uncommitted work) was copied at 22:33 and discarded unused. It was
never installed, and the installed `.so` hashes were checked against the wheel RECORDs before every phase.

Each of the two packmem builds has its own environment, so the arms can be interleaved run by run:
`venv` / `llava-next/venv` hold the candidate. `venv-pypi` / `llava-next/venv-pypi` are thin venvs holding only the
PyPI wheel, and they reach torch and the rest through a `.pth` line pointing at the first venv's site-packages. Their
own site-packages comes first on `sys.path`, which was checked: each loads its own `packmem/_packmem.abi3.so`, with the
hash in its wheel's RECORD.

- Qwen3-VL: `run_all_v3.sh build llava665k 5 g3_build orig repo@pypi repo` (repo tree = `packmem.v3.patch`): fresh
  `/usr/bin/time -l python -I bench_v3.py <tree> build llava665k`, which builds `LazySupervisedDataset` (665,298 rows),
  computes lengths, and runs 20k `__getitem__` + collate in-process.
- LLaVA-NeXT (`LLaVA-VL/LLaVA-NeXT` at `bce12e479bc4dfee2b9c50c88137b01ff51bd483`, `packmem.v2.patch`, synthetic 985,000-
  record mix regenerated with the v1 `gen_data.py`; Python 3.12.10, torch 2.15.0, transformers 4.49.0):
  `llava-next/harness/v3/runs.sh g3 5 repo-orig repo@pypi repo`, each a fresh
  `/usr/bin/time -l python -I run_v2.py <tree> data/mix.yaml --workers 0`, as in its v2.
- Arm order reversed on even runs. Every run waited for 1-minute load ≤ 4 (max 10 min). All 30 candidate-gate runs
  started at load 2.20-3.98, with no timeouts (per-run loads in `out/g3_build/*.load` and `llava-next/harness/v3/results.jsonl`).
- Qwen MB = 10^6 bytes. LLaVA-NeXT MiB, as in its v2. Peak = `time -l` peak memory footprint. After build =
  `phys_footprint` once the dataset is built and `gc.collect()` has run.

## Qwen3-VL (median of 5, 00:02-00:11 CET)

| | list | packmem 0.1.1 (PyPI) | **candidate 630df090** | candidate vs 0.1.1 |
| --- | --- | --- | --- | --- |
| Dataset build | 2.67 s | 7.36 s (7.32-7.49) | **5.75 s** (5.75-5.77) | **-1.61 s (-22%)** |
| Peak footprint | 5,238 MB | 726 MB (724-727) | **722 MB** (717-724) | -4 MB (-0.6%) |
| Footprint after build | 5,203 MB | 623 MB (623-624) | **576 MB** (574-578) | **-47 MB (-7.5%)** |
| `Table.nbytes` | n/a | 307,633,620 B | 308,305,695 B | **+672,075 B (+0.22%)** |
| `lengths` / `modality_lengths` | 2.17 / 2.18 s | 4.81 / 4.86 s | 4.68 / 4.64 s | -3% / -5% |
| 20k `__getitem__` + collate | 4.99 s | 4.98 s | 5.01 s | +0.03 s (+0.6%, within run-to-run spread 4.97-5.36) |
| Wall time | 16.3 s | 23.1 s | 21.1 s | -2.0 s |
| `PACKMEM_LOAD_THREADS=1`, 1 run | | | build 3.92 s, peak 883 MB, after build 766 MB | |

## LLaVA-NeXT (median of 5, 00:11-00:27 CET)

| | list | packmem 0.1.1 (PyPI) | **candidate 630df090** | candidate vs 0.1.1 |
| --- | --- | --- | --- | --- |
| `LazySupervisedDataset(...)` construction | 5.17 s | 22.25 s (22.10-23.30) | **20.61 s** (20.33-21.54) | **-1.64 s (-7%)** |
| Peak footprint | 5,188 MiB | 1,829 MiB (1,820-1,832) | **1,819 MiB** (1,812-1,819) | -10 MiB (-0.5%) |
| Footprint after build | 3,888 MiB | 1,553.3 MiB (1,551.6-1,564.3) | **1,553.8 MiB** (1,549.9-1,556.3) | +0.5 MiB (+0.03%, ranges overlap: noise) |
| `Table.nbytes` | n/a | 715,848,543 B | 715,848,543 B | identical |
| `lengths` / `modality_lengths` | 4.90 / 5.02 s | 8.47 / 8.47 s | 8.29 / 8.34 s | -2% / -2% |
| 20k samples through the DataLoader | 1.58 s | 1.89 s | 1.83 s | -3% |
| `PACKMEM_LOAD_THREADS=1`, 1 run | | | 16.46 s, peak 1,874 MiB, after build 1,606 MiB | |

## Is anything in the candidate slower or larger than 0.1.1 at its default?

- **Build time: no.** -22% on Qwen3-VL, -7% on LLaVA-NeXT. `lengths`/`modality_lengths` and per-sample reads are the same
  or faster. Qwen's 20k getitem median is 0.03 s higher, inside the spread of either arm.
- **Peak footprint: no.** -4 MB and -10 MiB.
- **Footprint after build: no.** -47 MB on Qwen. LLaVA-NeXT is level, at +0.5 MiB of median difference with overlapping
  ranges.
- **Packed table: yes, on Qwen3-VL's real data, by 672,075 bytes (+0.22%).** The cause is the documented nested-text
  change. The real LLaVA-1.5 file escapes non-ASCII as `\uXXXX` (3,851,037 escapes). 0.1.1 decoded and re-serialised nested
  values, writing UTF-8 and leaving 439 `\u` escapes in `to_json()`. The candidate keeps all 3,851,037 as written. Decoded rows are
  identical (row hash below), but `to_json()` grows from 764,022,424 to 776,385,527 bytes (+1.6%), and its bytes differ
  from 0.1.1's. LLaVA-NeXT's synthetic data has no escapes: nbytes and `to_json()` are byte-identical there. On Qwen's
  mixed path the candidate's table is smaller than 0.1.1's (263,537,060 vs 263,656,996 B).

## Identical output

| check | list | 0.1.1 | candidate | earlier runs |
| --- | --- | --- | --- | --- |
| Qwen rows, 665,298, sorted keys | `7357e4d6fdc54be3` | `7357e4d6fdc54be3` | `7357e4d6fdc54be3` | v2, v3 |
| Qwen lengths / 20k batches (all 15 g3 runs + threaded run) | `348d788a1e` / `3c98d76114` | same | same | v2 |
| Qwen mixed `llava665k%50,llava150k`: lengths / batches | `1e6c2d7714` / `93fd1a67ea` | same | same | v2 `93fd1a67ea` |
| LLaVA-NeXT lengths / 20k batches (all 15 g3 runs + threaded) | `e45b09149f` / `392700325fba` | same | same | v2 |
| LLaVA-NeXT `mix.yaml` (`bench.py --hash`): lengths, modality, 10k ids, rows sorted keys | `9756559` `4cd075c` `dec1480` `b98466ab5d0a` | same | same | v2 |
| LLaVA-NeXT `mix.yaml` rows in key order | `6ec63727dcf7` | `0efe39901d2f` | `0efe39901d2f` | v2 (orig / patched) |
| LLaVA-NeXT `mix_random.yaml`: rows sorted keys / key order | `e78cd672df0b` / `b94fb1c0da68` | `e78cd672df0b` / `ff6628fe7bfd` | same as 0.1.1 | v2 |
| `nestcheck.py` decoded rows, 4 files | | same as candidate | same as 0.1.1 | |
| `nestcheck.py` `to_json()` bytes | | | differ on Qwen's real file only (escapes); equal on 3 synthetic files | |

## The opt-in thread (`PACKMEM_LOAD_THREADS=1`): what the extra memory is, and whether it comes back

`mixcheck.py repo` (Qwen) and `llava-next/harness/v3/vmcheck.py`: one fresh process per configuration builds the
dataset, then records malloc in-use (`malloc_zone_statistics`) and `vmmap -summary`. It then allocates and writes
650 MB in 2/4/8/16/32 MiB `bytearray`s and measures how much the footprint grew (`memprobe.py`, `out/g3/vm_*`):

| Qwen3-VL, after build | 0.1.1 | candidate default | candidate threads=1 |
| --- | --- | --- | --- |
| phys_footprint | 626.9 MB | 577.6 MB | 762.3 MB |
| malloc in-use (live) | 409.7 MB | 410.2 MB | 410.1 MB |
| vmmap `MALLOC_LARGE` dirty (live, mostly the table) | 255.9 MiB | 216.5 MiB | 238.7 MiB |
| vmmap `MALLOC_LARGE (empty)` dirty (freed, resident) | 86.8 MiB | 73.9 MiB | **230.8 MiB** |
| footprint growth for 650.1 MB of later allocations | 618.4 MB | 627.6 MB | **505.8 MB** |
| memory reused instead of newly mapped | 31.7 MB | 22.5 MB | **144.3 MB** |
| footprint after those allocations | 1,245 MB | 1,205 MB | 1,268 MB |

The threaded run's extra ~185 MB is not live data: malloc in-use is the same in all three. It is freed memory still
resident in `MALLOC_LARGE (empty)` (+157 MiB against the default). A later round of large allocations reuses about 120 MB more of it than the
default does, so the gap shrinks from 185 MB to 63 MB. It is reclaimable by reuse, though not returned on its own.
LLaVA-NeXT shows little of this: threads=1 gives 1,654.6 vs 1,630.4 MB footprint, malloc in-use 838.2 in both, and
`MALLOC_LARGE (empty)` dirty 830.8 vs 799.9 MiB. All LLaVA-NeXT arms hold about 800 MiB of freed-but-resident large
blocks after construction. 0.1.1 holds 829 MiB.

## Superseded: candidate 75dbc431 (a78832a, background packing on by default)

Same method, measured before the candidate changed. Qwen (median of 5, interleaved with list and 0.1.1, 23:12-23:51 CET;
two runs started after a 10-minute load timeout, at 7.06 and 7.95):

| | list | 0.1.1 (PyPI) | 75dbc431 default (threaded) | 75dbc431 `PACKMEM_LOAD_THREADS=0` (1 run) |
| --- | --- | --- | --- | --- |
| Build | 2.53 s | 7.54 s | 4.01 s | 6.35 s |
| Peak footprint | 5,237 MB | 725 MB | **881 MB (+156)** | 716 MB |
| After build | 5,201 MB | 622 MB | **762 MB (+140)** | 572 MB |
| nbytes | | 307,633,620 | 308,305,695 | 308,305,695 |

LLaVA-NeXT 75dbc431 (incomplete when the candidate changed; 1-2 runs per arm): 0.1.1 22.0 s / 1,808 MiB peak; 75dbc431
16.6 s / 1,829-1,875 MiB peak, 1,590 MiB after build. The f34d69df build (the share() wheel) measured 22.2 s / 1,826 MiB
on LLaVA-NeXT and 7.65 s / 718 MB on Qwen (3 runs each).

---

# Mixed path (`llava665k%50,llava150k`): why the footprint is higher than for one file

`mixcheck.py steps` follows the v3 patch by hand and records `nbytes`, malloc in-use and footprint after each step.
`mixcheck.py repo` builds the repository's dataset. The second file is the first 150,000 records of the 665k file, as in v1.

| step (f34d69df wheel) | rows | nbytes | malloc in-use | phys_footprint |
| --- | --- | --- | --- | --- |
| `load_json` 665k | 665,298 | 307.6 MB | 317.8 MB | 455.8 MB |
| `take` 50% | 332,649 | 173.1 MB | 179.5 MB | 666.3 MB |
| `set_column` | 332,649 | 173.1 MB | 179.6 MB | 666.3 MB |
| `load_json` 150k | 150,000 | 90.6 MB | 271.0 MB | 659.5 MB |
| `extend` | 482,649 | 263.7 MB | 270.8 MB | 709.4 MB |
| same rows repacked from dicts, `Table(list(t))` | 482,649 | 263.5 MB | | |
| `copy()` of the final table | 482,649 | 263.7 MB | | |

| repository build, after `gc.collect()` | nbytes | malloc in-use | phys_footprint |
| --- | --- | --- | --- |
| one file (`llava665k`), f34d69df | 307.6 MB | 409.8 MB | 621.3 MB |
| mixed, f34d69df | 263.7 MB | 362.5 MB | 870.8 MB |
| mixed, PyPI 0.1.1 | 263.7 MB | 362.7 MB | 875.7 MB |
| mixed, candidate 630df090 | 263.5 MB | 362.3 MB | 862.8 MB |

**Allocator retention, not a packing bug.** The mixed table is smaller than the one-file table (263.7 vs 307.6 MB) and
the same size as a fresh pack of the same rows (263.5 MB). Live malloc memory is 47 MB lower than for one file. The
footprint is 250 MB higher because the 307.6 MB table that `take` replaces, and the transients of the second load, are
freed but stay resident. `phys_footprint` rises by 211 MB at the `take` step, while malloc in-use falls by 138 MB.
`take`/`extend` produce chunks packed as tightly as a fresh pack. The candidate shows the same pattern.

---

# Files

- `RESULT.md` (this file); `packmem.v3.patch`; `share.patch`
- `harness/v3/`: `bench_v3.py`, `wprobe.py`, `run_all_v3.sh`, `wait_load.sh`, `sequence_v3.sh`, `summarize_v3.py`,
  `mapprobe.py`, `mixcheck.py`, `memprobe.py`, `nestcheck.py`, `summarize_build.py`, `sequence_build.sh` (stopped),
  `sequence_gate.sh` (75dbc431, stopped), `sequence_gate2.sh` (never ran), `sequence_gate3.sh`; `load.log`;
  `out/<tag>/<arm>_<n>.{json,time,load,log,pkmleft}`; `out/mapprobe/`, `out/diag_spawn20k/*.diag/`, `out/addon/`, `out/g3/`
- `llava-next/harness/` (v1/v2 scripts with paths fixed), `llava-next/harness/v3/{runs.sh,vmcheck.py,results.jsonl,load.log,verify_g3/}`

---

# Zero-copy share() v2 on Qwen3-VL (wip/zero-copy-v2)

Wheels, each in its own venv. `venv-f34d`, `venv-v2` and `venv-v2b` are thin venvs holding only that wheel, and they reach torch
and the rest through a `.pth` line pointing at `venv`'s site-packages. The installed `.so` was checked against each
wheel's RECORD. No pickle or .pkm crossed builds: every run is one process tree with one venv.

| arm | tree | wheel |
| --- | --- | --- |
| repo, plain pickle | `repo/` | candidate 630df090 (`venv`) |
| share v1 (copy on attach) | `repo-share/` | f34d69df (`venv-f34d`) |
| **share v2** (map in place) | `repo-share/` (no patch change) | `f9f57281c5f8bc18170a2f9123ea0634a40e4b30a484f71b330f57e3146562f1`, 3fa7264 (`venv-v2`) |
| **open v2** | `repo-open/` = `repo/` + `open.patch` (`save(PACKMEM_SAVE_PATH)`, then `packmem.open`) | same as share v2 |
| share v2b (see next section) | `repo-share/` | `7997bb7b1cdaf2744cfa02105c6aa431a648175f9401a911f72c1d8533ac56bd`, 7de0b93 (`venv-v2b`) |

Method: the A config (20k seeded indices, batch 4, 4 workers), `run_all_v3.sh loader llava665k 3 <tag> <arms>`, arms
interleaved, 3 runs each, every run started at load ≤ 4.00 with no timeouts, 00:47-01:20 CET. `bench_v3.py` additions:
- `mincore()` residency of the .pkm right after the build, right before `iter(dl)` and after the last batch.
- `PKM_COLD=1` (cold first touch, no sudo). Just before `iter(dl)`, the .pkm is copied through `F_NOCACHE` read and
  write descriptors into a new inode, fsynced, and renamed over the same path, keeping the mode. `mincore()` then
  reads **0.0 resident in every cold run**, so the cold state is verified, not assumed. Warm runs read 1.0, because
  share()/save() has just written the file. The eviction (0.15-0.32 s) happens before the timed window.
- Footprint and RSS of every child at the 50% batch. Under forkserver this includes the forkserver process (184 MB),
  which is **added to the peak sum**. torch's 4 `torch_shm_manager` helpers (about 220 MB together) exist in every arm,
  in earlier sections too, and are excluded as before.
- DIAG runs (`footprint` / `vmmap -summary` per worker at `worker_init` and at the 50% batch) were cut by the
  coordinator's time limit for v2. One v2b DIAG run is below.

The list-of-dicts arm does not fit under spawn or forkserver: about 18.9 GB is available and v2 measured 23.5 GB. The
v2 spawn numbers stand (22,687 MB peak sum, 24.6 s to first batch). Orig under forkserver was never measured on macOS.

## spawn, 4 workers (median of 3; MB)

| | repo, plain pickle | share v1 | **share v2** | **open v2** |
| --- | --- | --- | --- | --- |
| Parent peak | 1,315 | 726 | 715 | 689 |
| Worker after unpickling (worker_init) | 802-806 | 493-495 | **185-187** | **185-187** |
| Worker at 50% / lifetime peak | 805-809 / 806-809 | 496-498 / 497-499 | **187-190 / 188-191** | **188-190 / 188-191** |
| Worker RSS at worker_init / at 90% | 854-858 / 861-864 | 545-547 / 551-554 | 247-249 / **318-321** | 247-249 / **319-321** |
| **Parent + 4 workers, peak sum** | **4,542** (4,547 / 4,542 / 4,541) | **2,715** | **1,471** (1,478 / 1,470 / 1,471) | **1,448** (1,443 / 1,448 / 1,448) |
| Worker start to first batch, workers 0-3 | 3.50 / 2.64 / 1.76 / 0.93 s | 1.08-1.09 s | 0.95-0.96 s | 0.94-0.95 s |
| `iter(dl)` to first batch | 3.66 s | 1.19 s | **1.05 s** | 1.04 s |
| `iter(dl)` to last batch | 5.48 s | 3.04 s | 2.98 s | 2.80 s |
| Dataset build (includes share()/save+open) | 5.63 s | 7.32 s | 5.66 s | 5.80 s |

## forkserver, 4 workers (median of 3; MB; peak sum includes the 184 MB forkserver process)

| | repo, plain pickle | share v1 | **share v2** | **open v2** |
| --- | --- | --- | --- | --- |
| Parent peak | 1,312 | 724 | 718 | 690 |
| Worker after unpickling | 652-653 | 343-344 | **32-33** | **33** |
| Worker at 90% / lifetime peak | 675-683 / 676-683 | 366-374 / 367-375 | **56-63 / 56-64** | **56-63 / 56-64** |
| Worker RSS at 90% | 689-696 | 380-388 | 145-153 | 145-152 |
| **Peak sum** | **4,208** | **2,385** | **1,135** (1,135 / 1,134 / 1,137) | **1,108** |
| Worker start to first batch | 0.11-0.30 s | 0.07-0.08 s | 0.02-0.03 s | 0.02-0.03 s |
| `iter(dl)` to first batch (includes starting the forkserver) | 1.24 s | 0.95 s | **0.89 s** | 0.89 s |
| `iter(dl)` to last batch | 3.07 s | 2.73 s | 2.77 s | 2.68 s |

## Cold vs warm first touch (cold = 0.0 of the .pkm resident before `iter(dl)`, verified by mincore)

| | share v1 warm / cold | share v2 warm / cold | open v2 warm / cold |
| --- | --- | --- | --- |
| spawn, `iter(dl)` to first batch | 1.19 / **1.89 s** (3 runs) | 1.05 / **1.11 s** (3) | 1.04 / 1.34 s (2: 1.61, 1.08) |
| spawn, `iter(dl)` to last batch | 3.04 / 3.72 s | 2.98 / 3.27 s | 2.80 / 3.51 s |
| spawn, file resident after the run (cold) | 1.00 | 0.58-0.82 | 0.74-0.78 |
| forkserver, first / last batch (cold: 1 run each) | 0.95 / 2.73 -> **2.09 / 4.09 s** | 0.89 / 2.77 -> **1.13 / 3.59 s** | not run (time limit) |

Cold, v1 pays for reading the whole 308 MB file before the first batch: +0.7 s spawn, +1.1 s forkserver. v2 starts
almost as fast cold as warm (+0.06 / +0.24 s) and pays later, as pages fault in during the epoch: +0.3 s spawn and
+0.8 s forkserver by the 20k-th sample. Over 20k random samples the workers together touched 58-82% of the file's pages.

## What moved from private memory into the page cache

- v2 removes the private copy. A spawn worker drops from 493-499 MB (v1) to 185-191 MB, about the interpreter, torch
  and the dataset module. Under forkserver it drops from 343-375 MB to 32-64 MB, because those workers share the
  forkserver's interpreter pages copy-on-write. The ~310 MB difference per worker is the table.
- The table is now file-backed, clean and shared. It shows in RSS, not in phys_footprint: worker RSS minus footprint grows from
  62 MB at worker_init (libraries) to about 130 MB at 90% under spawn (89-97 MB under forkserver). The extra 60-70 MB is
  the part of the file a worker has touched so far, as page cache counted once for all workers. In the cold runs
  `mincore` shows 58-82% of the file (180-250 MB) resident after the run, shared by the four workers and the OS.
- The parent's own table is still private for share v2 (parent peak 715-718 MB, the same as v1). For open v2 the
  parent also reads from the mapping: 689-690 MB, about 26-30 MB lower. v2b (below) is meant to close that gap.

## Files and lifetime (v2)

- share v2 .pkm: 308,297,418 bytes (v1 format: 307,625,077), `$TMPDIR/packmem-<pid>-<hex>.pkm`, mode `-rw-------` in every
  run. It existed after the last batch and was gone after exit in every run (`.pkmleft` empty).
- open v2 file: 308,297,418 bytes at `$TMPDIR/qwenopen-<tag>-repo-open-<n>.pkm`. Its mode is **`-rw-r--r--`** (from the umask;
  `save()` does not use 0600, unlike `share()`). It is kept after exit by design; the harness deletes it after each run.
- Batch hashes: lengths `348d788a1e`, batches `3c98d76114` in all 24 warm runs, 10 cold runs and smoke tests: every arm,
  spawn and forkserver, the same as v2/v3.

## Not measured (stopped on request so the laptop could be closed)

- **share v2b (7997bb7b, 7de0b93) on this Mac: skipped**, since it was measured on Linux. One spawn run finished and a
  second was killed. Both are in `harness/v3/out/aborted/Y_spawn/` and are not reported.
- Not done: the v2 DIAG runs (per-worker `footprint`/`vmmap` "mapped file" figures at worker_init and at the 50% batch),
  the forkserver cold run of open v2 and the 2nd/3rd forkserver cold runs, the third spawn cold run of open v2, and
  `v2probe.py` (the read-only and lifetime checks for v2: script written, not run). The mapped-file figures above come
  from RSS minus phys_footprint and from `mincore`, not from vmmap.

## Final cleanup

`packmem.cleanup_stale()` under the candidate, f34d69df and v2 wheels: 0 removed each. `$TMPDIR` holds no `*.pkm`,
`qwenopen-*` or `.cold` files. Every `.pkmleft` record is empty. Deleted: `data/`, `venv`, `venv-f34d`, `venv-v2`,
`venv-v2b` (and earlier `venv-pypi` and all of `llava-next`'s venvs and data). Kept: scripts, results, patches, the
worktrees (`orig/`, `repo/`, `repo-share/`, `repo-open/`) and the copied wheels (`wheel*/`, 2.6 MB).

Additional files for the v2 section: `open.patch`; `harness/v3/{sequence_v2share.sh, summarize_z.py, v2probe.py,
sequence_v2b.sh}`; `harness/v3/out/Z_{spawn,fork,spawn_cold,fork_cold}/`; smoke runs in `smoke/`.
