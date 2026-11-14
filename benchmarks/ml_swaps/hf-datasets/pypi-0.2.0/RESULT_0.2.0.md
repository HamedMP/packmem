# PyTorch DataLoader memory: Python list vs Hugging Face `datasets` vs packmem 0.2.0 (LLaVA-1.5 mix665k annotations)

This rerun of the DataLoader comparison uses the **published PyPI packmem 0.2.0**: the list, HF memory-mapped Arrow,
packmem `share()` and packmem `save()` + `packmem.open()`, each under fork and forkserver, measured on one Linux host
in one session with one venv. It also measures the per-process import cost and the size of each mapped file.
Earlier work is in `../RESULT.md` (the first three-way run, with 0.1.1) and `../zero-copy/RESULT_v2.md` (pre-release v2 builds).

## How to quote these numbers

- **Memory figures are robust.** Each arm's memory is the same to within about 1 MB across 3 runs, and matches the
  earlier sessions to within a few MB under very different host load (HF forkserver node PSS: 1,811 / 1,810 / 1,810 MB
  in three sessions).
- **Timings are indicative.** The host also runs CI. The 1-minute load was 9.8-26.9 during the DataLoader runs.
  Differences under about 0.3 s in first-batch time are noise.
- **Scope:** one process with a PyTorch DataLoader of 4 workers. The dataset is the 665k LLaVA-1.5 annotation records
  (conversation text and image paths only, no images), batch size 8, 20k random indices, and a collate that hashes text.
  There is no model, no GPU and no image decoding. It measures what holding and serving the annotations costs.
- **"Anon above floor"** is anonymous (non-reclaimable, non-shared) memory summed over the parent and workers, minus the
  same sum for a DataLoader serving a constant record with the same imports. Memory-mapped file pages (the Arrow cache,
  a saved .pkm) are reclaimable page cache and are reported separately. A `share()` file in /dev/shm is RAM.

Short version, forkserver (the start method that pickles the dataset to each worker):

| | node peak PSS | anon above floor | parent peak USS | first batch | sent to each worker |
|---|---|---|---|---|---|
| Python list | 15,961 MB | +15,099 MB | 3,810 MB | 63.5 s | 687 MB pickle |
| HF `datasets`, memory-mapped Arrow | 1,810 MB | +243 MB | 379 MB | 1.80 s | 2.2 KB |
| packmem 0.2.0 `share()` (/dev/shm) | **1,148 MB** (1,182 with the whole tmpfs file) | **+10 MB** | **249 MB** | 1.07 s | 136 B |
| packmem 0.2.0 `save()` + `open()` | **1,144 MB** | **+5 MB** | **245 MB** | 1.02 s | 134 B |

## Results

### (c) `share()` after 0.2.0's malloc_trim

0.2.0's `share()` re-attaches the sharing process to the file and then calls `_Table.release_freed_memory()`.
The extension imports `malloc_trim@GLIBC_2.2.5`.

| | anon above matched floor, forkserver | parent peak USS, forkserver | anon above floor, fork | parent peak USS, fork |
|---|---|---|---|---|
| pre-release 7de0b93 `share()` (RESULT_v2.md, v2b) | +85 | 324 | +89 | 324 |
| **0.2.0 `share()`** | **+10** | **249** | **+14** | **249** |
| 0.2.0 `save()` + `open()` (control, same day) | +5 | 245 | +4 | 245 |
| pre-release `open()` (RESULT_v2.md) | +5 / +6 | 245 | +4 | 245 |

One process with no DataLoader (`diag_share.py`), parent Pss_Anon:

| after `load_json` | after id normalization | after `share()` | after an extra `malloc_trim(0)` |
|---|---|---|---|
| 375.7 | 377.1 | **14.8** (pre-release 90.2) | 14.8 (nothing left to trim) |

The pre-release's 76 MB of retained glibc heap is gone. `share()` now leaves the parent 4 MB above `open()` (parent
Pss_Anon after load 161 against 157 MB). That is the hand-off overhead and is within the residue of having built the
table from JSON in that process.

### DataLoader, forkserver (MB = 10^6 B; median of 3; per-worker ranges cover all 12 workers)

| Arm | node peak PSS sum | incl. whole tmpfs file | node peak Pss_Anon sum | anon above matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled to each worker |
|---|---|---|---|---|---|---|---|---|---|
| A list | 15,961 | | 15,884 | +15,099 (E0) | 0 | 3,810 | 63.47 | 65.74 | 687.4 MB |
| B1 HF Arrow mmap | 1,810 | | 1,083 | +243 (E) | 0 | 379 | 1.80 | 2.61 | 2,230 B |
| V2S packmem `share()` | 1,148 | 1,182 | 795 | +10 (E0) | 275 | 249 | 1.07 | 1.49 | 136 B |
| V2O packmem `save()` + `open()` | 1,144 | | 790 | +5 (E0) | 0 | 245 | 1.02 | 1.41 | 134 B |
| E floor (datasets + pyarrow + packmem imported) | 961 | | 840 | | 0 | 327 | 1.02 | 1.38 | 151 B |
| E0 floor (packmem imported) | 863 | | 785 | | 0 | 228 | 0.94 | 1.26 | 151 B |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| A list | 3,026-3,293 | 3,041-3,307 | 3,026-3,293 | 3,026-3,293 |
| B1 HF | 251-257 | 385-387 | 213 | 213 |
| V2S `share()` | 170-179 | 237-239 | 170-179 | 155 |
| V2O `open()` | 170-176 | 237-239 | 155 | 155 |
| E / E0 floors | 154 | 169 | 154 | 154 |

Resident pages of the shared file in each worker at the end of the epoch (`/proc/<pid>/smaps`, the mapping of the
.arrow / .pkm file):

| Arm | file | map Rss | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss | peak map Rss |
|---|---|---|---|---|---|---|---|---|
| B1 HF | `json-train.arrow` | 406-408 | 367-369 | 38-41 | 0 | 0 | 148-150 | 406-408 |
| V2S `share()` | `/dev/shm/packmem-<pid>-<hex>.pkm` | 175-178 | 0 | 0 | 160-161 | 15-17 | 67-69 | 175-178 |
| V2O `open()` | `pkm/mix665k.pkm` | 175-178 | 160-161 | 15-17 | 0 | 0 | 67-69 | 175-178 |

### DataLoader, fork

| Arm | node peak PSS sum | incl. whole tmpfs file | node peak Pss_Anon sum | anon above matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s |
|---|---|---|---|---|---|---|---|---|
| A list | 3,604 | | 3,528 | +3,335 (E0) | 0 | 3,115 | 0.32 | 2.01 |
| B1 HF Arrow mmap | 994 | | 269 | +30 (E) | 0 | 378 | 0.04 | 0.63 |
| V2S packmem `share()` | 559 | 593 | 207 | +14 (E0) | 275 | 249 | 0.03 | 0.35 |
| V2O packmem `save()` + `open()` | 549 | | 197 | +4 (E0) | 0 | 245 | 0.03 | 0.34 |
| E floor | 358 | | 239 | | 0 | 327 | 0.05 | 0.35 |
| E0 floor | 270 | | 193 | | 0 | 228 | 0.02 | 0.29 |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| A list | 120-121 | 724-725 | 120-121 | 721-722 |
| B1 HF | 50-53 | 205-207 | 12 | 53-54 |
| V2S `share()` | 26-27 | 111-113 | 26-27 | 41-42 |
| V2O `open()` | 24-26 | 109-111 | 9 | 39 |
| E floor | 6 | 49-50 | 6 | 47-48 |
| E0 floor | 8 | 41 | 8 | 38-39 |

| Arm | file | map Rss | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss |
|---|---|---|---|---|---|---|---|
| B1 HF | `json-train.arrow` | 406-407 | 367-368 | 38-41 | 0 | 0 | 148-150 |
| V2S `share()` | `/dev/shm/packmem-<pid>-<hex>.pkm` | 175-178 | 0 | 0 | 159-161 | 15-17 | 67-69 |
| V2O `open()` | `pkm/mix665k.pkm` | 175-178 | 159-161 | 15-17 | 0 | 0 | 67-69 |

Under fork, `share()` now helps too. The parent reads the table from the file, so fork workers map the file (176 MB
resident each) instead of inheriting a 308 MB anonymous table. Node PSS is 559 MB against 0.1.1's 642 MB (RESULT_v2.md),
and anon above floor is +14 against +371.

### Correctness

- **DataLoader batch digests:** `debc56792e4b2a2eb457fa213fddff123f3639c962b60c6acd2e59bd6578714f` in all 24 data
  runs (list, HF, `share()` and `open()`; fork and forkserver; 3 rounds). This is the same digest as in RESULT.md and
  RESULT_v2.md.
- **Full table, all 665,298 records:** the canonical per-record digest is
  `63938d0e8a06b842c2466902dedac56c9f4d693f87f8b22eab1f5d1e8047c8f8` for HF (`hash_B1`), for the parent reading its
  `share()`d table (`hash_V2S`) and for `packmem.open()` of the saved file (`hash_V2O`). For packmem the raw (unstripped)
  digest is the same value. This matches the list's digests from RESULT.md. `packmem.open(path) == t` returned True.

### (b) Mapped file sizes

| File | Bytes | MB | Location | Mode |
|---|---|---|---|---|
| HF Arrow cache (`json-train.arrow`, one file; the whole cache) | 785,116,248 | 785.1 | `$WORK/hf/cache_B1/json/default-*/0.0.0/*/` | 0664 (umask) |
| packmem `share()` file | 308,680,442 | 308.7 | `/dev/shm/packmem-<pid>-<16 hex>.pkm` (tmpfs) | **0600** |
| packmem `save()` file | 308,680,442 | 308.7 | `$WORK/pkm/mix665k.pkm` (ext4) | 0664 (umask) |

- The Arrow cache is **2.54x** the packmem file.
- Each worker touched 407 MB of the Arrow file against 176 MB of the .pkm for the same 5k rows, so the page-cache
  working set is 2.3x smaller.
- The two .pkm files are byte-identical in size, equal to `to_bytes()`. The saved file's sha256 is
  `67da8f3a4255264fdb4c2123756b84956b7f687418b877d02f023aa1d4759a1a`, unchanged from the pre-release builds.
- Time to write: `share()` 0.15-0.19 s; `save()` 0.21 s once; `open()` 2-3 ms; HF's first conversion 22.4 s.
- Clean-up: the `share()` file is removed when the parent exits. Every run started and ended with 0
  `/dev/shm/packmem-*.pkm` files.
- `save()` deliberately does not force 0600. It writes an ordinary user file, so the mode follows the umask.

### (a) Import cost per process

The method reproduces `demos/finetune-loader/costs.py` (packmem main). A fresh `python -I` imports the listed modules
and reports psutil RSS, costs.py's Linux metric. `scripts/import_cost.py` adds PSS, USS and Pss_Anon from
`/proc/self/smaps_rollup`, and probes the bare interpreter and each library without torch. Median of 5 fresh processes.
MB, run at load 22.3 -> 16.7.

| Imports | RSS | PSS | USS | Pss_Anon |
|---|---|---|---|---|
| bare python 3.12 | 13.9 | 8.0 | 6.5 | 6.5 |
| packmem | 19.6 | 13.6 | 11.9 | 11.0 |
| pyarrow | 56.8 | 49.1 | 47.2 | 20.4 |
| datasets (pulls in pyarrow) | 144.9 | 134.0 | 131.7 | 82.7 |
| torch | 235.2 | 224.3 | 222.2 | 154.5 |
| torch + packmem | 236.0 | 225.1 | 223.0 | 154.7 |
| torch + pyarrow | 261.8 | 250.8 | 248.5 | 159.5 |
| torch + datasets | 334.2 | 323.2 | 320.9 | 210.0 |

| Extra cost | RSS | PSS | USS | Pss_Anon |
|---|---|---|---|---|
| packmem over bare python | +5.8 | +5.5 | +5.4 | +4.6 |
| datasets over bare python | +131.1 | +126.0 | +125.2 | +76.2 |
| packmem over torch | **+0.8** | +0.8 | +0.8 | **+0.2** |
| datasets over torch | **+99.0** | +98.9 | +98.8 | **+55.5** |

This is the per-worker difference seen in the DataLoader under forkserver: HF workers have 213 MB of Pss_Anon, against
155 MB for packmem workers and 154 MB for the floor. Each forkserver or spawn worker is a fresh interpreter that imports
what unpickling the dataset needs. With 4 workers, datasets costs about 4 x 56 = 222 MB of anonymous memory, which is
most of HF's +243 MB above the floor. The private part of RSS/USS beyond Pss_Anon is mostly read-only library text,
shared or reclaimable.

## Verdict

- **Under forkserver, packmem 0.2.0 beats HF Arrow on every memory figure.** Node peak PSS is 1,148 / 1,144 MB against
  1,810 MB (-37%). Anonymous memory above the floor is +10 / +5 MB against +243 MB. Parent USS is 249 / 245 MB against
  379 MB. Per worker, Pss_Anon is 155 against 213 MB. First batch was 1.07 / 1.02 s against 1.80 s, essentially the floor
  (0.94-1.02 s); treat the timing as indicative.
- **Under fork, packmem beats HF on node PSS** (559 / 549 against 994 MB), and on anonymous memory above the floor
  (+14 / +4 against +30).
- **The malloc_trim in 0.2.0 closes the pre-release gap.** `share()` is now within 5 MB of `save()` + `open()` on every
  figure (+10 against +5, and 249 against 245 MB), down from +85 and 324 MB.
- **Against the list:** forkserver node PSS is 14x lower (1.15 GB against 16.0 GB). The first batch takes about 1 s
  against 63 s. The pickle sent to each worker is 136 B against 687 MB.
- Size: the Arrow cache is 2.54x the packmem file (785 against 309 MB). The import cost per worker is +0.2 MB anonymous
  for packmem against +55 MB for datasets.

## Setup and method

- **Host `linux-server`:** AMD Ryzen 9 7950X3D (32 threads), 124 GiB RAM, Ubuntu 24.04, kernel 6.8.0-139-generic,
  Python 3.12.3. It is shared with CI runners.
- **Venv:** one fresh `python3 -m venv` (`venv020`), pip cache inside the work dir.
- **packmem 0.2.0 from PyPI:** fetched with `pip download --no-deps --only-binary=:all: packmem==0.2.0`, giving
  `packmem-0.2.0-cp310-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`, sha256
  `09c5ba04ee380af34600af1c9d6fac3f3a0337ebeb19f75292eb6423633614c7` (matches the PyPI listing).
  `packmem.__version__ == "0.2.0"`.
- **Other packages:** datasets 5.2.0, pyarrow 26.0.1, huggingface_hub 2.4.0, numpy 2.5.4, psutil 7.2.2, torch
  2.15.0+cpu (`--index-url https://download.pytorch.org/whl/cpu`).
- **Data:** `liuhaotian/LLaVA-Instruct-150K` / `llava_v1_5_mix665k.json`, re-downloaded, 1,029,887,963 bytes, sha256
  `ce959ce6e23073ee1cd1a8a2ef1c633768c10d4174327b8b2dc7113b91af6cf8`.
- **HF input:** `prep_ids.py` rewrote the JSON with `str(id)`, exactly as in RESULT.md. This works around `datasets`
  5.2.0 silently JSON-encoding 158,383 mixed-type ids (see RESULT.md). The HF arm loads that file with explicit Features,
  `split="train"`, into a fresh cache dir: the first conversion took 22.4 s, and every later load memory-maps the cache.
- **packmem arms:** the parent runs `packmem.load_json(original file)`, then `t.set_column("id", [str(v) ...])`.
  - V2S then calls `t.share()`.
  - V2O uses `t.save(path)` once in a separate process (`prep_v2save.py`); each run then does `packmem.open(path)`.
- **List arm:** `json.load` plus `str(id)`.
- **Floors:**
  - E: a constant record, with datasets, pyarrow and packmem imported. This is the floor for HF.
  - E0: a constant record, with only packmem imported. This is the floor for the list and packmem, whose parents never
    import datasets or pyarrow.
  - Both were measured in this session.
- **DataLoader:** a map-style `Holder(Dataset)`, 4 workers, `batch_size=8`, `sampler = random.Random(0).sample(range(665298),
  20000)`, `persistent_workers=True`, and a collate that returns `sha256` of each record's conversation text.
- **Sampling:** a thread reads `/proc/<pid>/smaps_rollup` (and `/proc/<pid>/smaps` for the .arrow / .pkm mappings) for
  the parent and every descendant every 0.5 s, plus at the first batch and at the end of the epoch.
  - "Workers" exclude the forkserver and resource_tracker helpers, which are included in node sums.
  - "incl. whole tmpfs file" replaces the mapped PSS of a /dev/shm file with its full size, because tmpfs pages are RAM
    whether mapped or not.
  - The Arrow file and the saved .pkm were read fully into the page cache before each run, and residency was verified
    100% with `mincore`.
- **Order:** 3 rounds, each running fork then forkserver, each with the list, HF, `share()`, `open()`, E and E0 in that
  order. Every measured process is
  `nice -n 10 systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 venv020/bin/python -I scripts/<script>`
  (`scripts/run2.sh`).
  - Runs were strictly serial.
  - Before each run, the script checks that `free -g` available is at least 30 GB above the expected peak.
  - It records the 1-minute load at start and end, and the `/dev/shm/packmem-*.pkm` count before and after.
  - `run_all4.sh` pauses before any run while the load is above 60. It never triggered.

Commands:

```
scripts/setup4.sh                       # venv020, pip download + sha256, installs, data download + sha256
scripts/run_all4.sh all                 # prep (prep_ids, conv_B1, hash_B1, prep_v2save, hash_V2O, hash_V2S,
                                        #       import_cost, diag_share) then 3 rounds x {fork, forkserver} x {A, B1, V2S, V2O, E, E0}
PMB_SINGLE_VENV=1 venv020/bin/python -I scripts/summarize2.py out-0.2.0 > out-0.2.0/summary.md
```

## How to read the memory columns

- **Linux reports tmpfs pages as dirty.** `share()` puts the file in /dev/shm, so its pages appear as `Shared_Dirty`
  and `Private_Dirty`, never Clean. They are shared memory (`Pss_Shmem`), not anonymous memory. Each `share()` worker's
  `Private_Dirty` and USS (170-179 MB) therefore include 15-17 MB of tmpfs pages that only that worker touched. Its
  anonymous memory is Pss_Anon = 155 MB, the floor.
- **Disk-backed mappings (the Arrow cache, the saved .pkm)** are clean page cache. `Private_Clean` is a page that only
  one process has mapped so far. It becomes `Shared_Clean` as soon as another process maps it, and the kernel can drop
  it at any time.
- **PSS** splits shared pages among the processes mapping them, so node PSS sums count each page once. Pages of a
  disk file that nobody has mapped are not counted. Untouched pages of a tmpfs file are counted only in the
  "incl. whole tmpfs file" column.
- The resident pages per worker (407 MB .arrow, 176 MB .pkm after 5k rows each) grow toward the full file sizes over a
  full epoch. They stay shared.

## Caveats

- **Host load:** the host ran CI throughout. The 1-minute load was 9.8-26.9 during the DataLoader runs (median 15.7) and
  15.7-29.1 during prep. Timings vary with load: the list's forkserver first batch was 49-63 s across rounds. Memory did
  not vary.
- **Epoch length:** 20k samples, 5k per worker, not a full epoch. The list's fork workers grow with more samples, through
  copy-on-write of refcounts (120 MB each here). packmem's and HF's per-worker anonymous memory does not grow.
- **Rows only:** the measurement covers the annotations only. It holds no images, no tokenizer and no model.
- **What `share()` costs:** a tmpfs file in /dev/shm is RAM for as long as the sharing process lives (309 MB here,
  shown in the "incl. whole tmpfs file" column). `save()` + `open()` puts the same bytes in reclaimable page cache instead.
- **Load time:** `share()` still needs the JSON loaded in that process first. `load_json` takes about 8.2-9.6 s here,
  against `open()`'s 3 ms and HF's 0.02-0.03 s reload from its cache. Saving once and opening is the fastest start.
- **HF access paths:** HF's per-row `ds[i]` uses the default Python formatting, as in RESULT.md. Batched or arrow-format
  access in HF was not measured in the DataLoader.

## Load per run (1-minute, start -> end)

- phase `prep` started 2026-11-14T02:05:39+01:00
- prep_ids: load 26.29 -> 27.89, wall 33.9 s, available 94 GB
- conv_B1: 27.89 -> 28.86, 23.9 s, 97 GB
- hash_B1: 28.86 -> 29.12, 23.9 s, 97 GB
- prep_v2save: 29.12 -> 27.59, 26.6 s, 102 GB
- hash_V2O: 27.59 -> 25.40, 18.2 s, 104 GB
- hash_V2S: 25.40 -> 22.32, 26.3 s, 105 GB
- import_cost: 22.32 -> 16.74, 34.0 s, 106 GB
- diag_share_norm: 16.74 -> 15.71, 7.6 s, 109 GB
- phase `dl` started 2026-11-14T02:08:54+01:00
- dl_A_fork_1: 15.71 -> 14.77, 15.2 s, 109 GB
- dl_B1_fork_1: 14.77 -> 14.77, 3.8 s, 108 GB
- dl_V2S_fork_1: 14.77 -> 14.10, 10.7 s, 109 GB
- dl_V2O_fork_1: 13.45 -> 13.45, 2.8 s, 106 GB
- dl_E_fork_1: 13.45 -> 12.77, 3.4 s, 108 GB
- dl_E0_fork_1: 12.77 -> 12.77, 2.6 s, 109 GB
- dl_A_forkserver_1: 12.77 -> 10.50, 72.4 s, 109 GB
- dl_B1_forkserver_1: 10.50 -> 10.06, 5.1 s, 107 GB
- dl_V2S_forkserver_1: 10.06 -> 9.82, 11.2 s, 107 GB
- dl_V2O_forkserver_1: 9.82 -> 9.91, 3.4 s, 108 GB
- dl_E_forkserver_1: 9.91 -> 9.92, 3.9 s, 110 GB
- dl_E0_forkserver_1: 9.92 -> 9.92, 3.2 s, 110 GB
- dl_A_fork_2: 9.92 -> 11.00, 15.8 s, 109 GB
- dl_B1_fork_2: 11.00 -> 11.72, 4.2 s, 109 GB
- dl_V2S_fork_2: 11.72 -> 12.46, 11.5 s, 108 GB
- dl_V2O_fork_2: 12.46 -> 12.46, 3.3 s, 103 GB
- dl_E_fork_2: 12.46 -> 12.59, 3.5 s, 103 GB
- dl_E0_fork_2: 12.59 -> 12.59, 2.7 s, 104 GB
- dl_A_forkserver_2: 12.59 -> 24.80, 94.1 s, 104 GB
- dl_B1_forkserver_2: 24.80 -> 25.89, 7.5 s, 100 GB
- dl_V2S_forkserver_2: 25.89 -> 26.85, 14.2 s, 98 GB
- dl_V2O_forkserver_2: 26.85 -> 26.39, 4.6 s, 101 GB
- dl_E_forkserver_2: 26.39 -> 26.43, 5.5 s, 100 GB
- dl_E0_forkserver_2: 26.43 -> 26.00, 4.5 s, 99 GB
- dl_A_fork_3: 26.00 -> 25.77, 20.5 s, 102 GB
- dl_B1_fork_3: 25.77 -> 25.71, 5.2 s, 99 GB
- dl_V2S_fork_3: 25.71 -> 25.75, 12.9 s, 103 GB
- dl_V2O_fork_3: 25.75 -> 25.69, 3.6 s, 98 GB
- dl_E_fork_3: 25.69 -> 25.71, 4.3 s, 101 GB
- dl_E0_fork_3: 25.71 -> 25.89, 3.1 s, 102 GB
- dl_A_forkserver_3: 25.89 -> 22.66, 95.5 s, 101 GB
- dl_B1_forkserver_3: 22.66 -> 22.21, 7.0 s, 103 GB
- dl_V2S_forkserver_3: 22.21 -> 22.18, 13.2 s, 102 GB
- dl_V2O_forkserver_3: 22.18 -> 21.60, 4.0 s, 102 GB
- dl_E_forkserver_3: 21.60 -> 21.60, 4.1 s, 104 GB
- dl_E0_forkserver_3: 21.60 -> 21.55, 3.6 s, 106 GB

All 44 runs had rc=0, with 0 `/dev/shm/packmem-*.pkm` files before and after every run.

## Files

- `out-0.2.0/`: every run's JSON and stderr, `runs.jsonl` (loads, available memory, /dev/shm counts, page-cache
  residency checks), `summary.md`, `setup.log`.
- `scripts/` holds the harness:
  - `common.py`, `bench_dl2.py`, `bench_load.py`, `dlcommon.py`, `pcache.py`, `prep_ids.py`, `prep_v2save.py`,
    `import_cost.py`, `diag_share.py`, `run2.sh`, `run_all4.sh`, `setup4.sh`, `summarize2.py`.
  - Also the earlier runs' scripts.
- The wheel, the data, the HF cache, the .pkm, the venv, the pip cache and the per-record hash files were deleted after
  the run.
