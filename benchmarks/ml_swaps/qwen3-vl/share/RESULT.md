# packmem `Table.share()` in Qwen3-VL's fine-tuning dataset, 4 spawn DataLoader workers (macOS)

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
  (see the end of this file).
- **Not a bug, but worth knowing on macOS:** without /dev/shm the file lives on disk in `$TMPDIR`, which is per-user
  and swept by the OS only after days. A crashed trainer leaves 308 MB there until `cleanup_stale()` runs.
- Observation: with share(), all four workers reach `worker_init_fn` at the same moment, to the millisecond (for
  example 1.068 s in all four), although they were created 7 ms apart. Not investigated.
