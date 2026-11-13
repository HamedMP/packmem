# packmem vs Hugging Face `datasets` (Arrow, memory-mapped) vs a Python list: LLaVA-1.5 mix665k annotations

Question: could packmem improve Hugging Face `datasets`, or does it only replace plain Python lists?
The comparison holds the real `llava_v1_5_mix665k.json` (665,298 records) for training in three ways:
a `json.load` list, a `datasets.Dataset`, and a packmem `Table`.

**How to quote these numbers:**
- **Robust under load:** sizes and memory figures (file and cache sizes, `nbytes`, pickled sizes, RSS, PSS, Private_Dirty, anonymous memory above the floor). The host is a shared Linux server that also runs CI. Its 1-minute load ranged from 3 to 47 during these runs; every run's load is listed at the end.
- **Indicative only:** timings (load and conversion times, µs per access, time to first batch, pass times).
- **packmem version:** PyPI 0.1.1 (manylinux2014 x86_64 wheel, sha256 `34c1e283768e82250f13b735972316a47e8a372b01ba644a2b4cb72601a18617`; the wheel file is not included). That is before `Table.share()`.
- **What `share()` targets, not yet measured here:** the forkserver column. Each worker is sent the 308 MB pickled table (+1,843 MB anonymous memory across 4 workers, 4.83 s to first batch). The `share()` build (main, 12403b6 and later) has not been measured on this harness.

## Verdict

**The decision rule is not met. The honest positioning is "packmem replaces Python lists, not Arrow".**

| Rule | Needed | Measured | Pass? |
|---|---|---|---|
| packmem packed bytes vs Arrow cache | 3x or more smaller | 785.1 MB / 308.0 MB = **2.55x** | **no** |
| packmem random row to dict vs HF | within about 2x of HF | packmem 6.05 us, HF 22.2 us: packmem is **3.7x faster** | yes |

Only the speed condition holds. On size, Arrow is already within 2.6x of packmem, and the zstd parquet
source (163.7 MB) is smaller than packmem's packed form. For on-disk or at-rest storage, a
memory-mappable packmem format would beat neither. Its gain would be about 477 MB less page cache
per node. Arrow already shares that page cache across all workers and ranks.

What HF does better:
- **Near-zero private memory, shared across workers.** After a full pass, the B1 process has 102 MB of
  anonymous private memory. The other 749 MB is the mapped Arrow file, which is clean, file-backed,
  reclaimable page cache. With 4 fork workers, anonymous PSS summed over the node is 269 MB for HF against
  564 MB for packmem. The idle floor with the same libraries imported is 239 MB, so the data costs HF
  +30 MB and packmem +325 MB.
- **Zero-copy hand-off to workers.** Under forkserver, the HF dataset pickles to 2.2 KB, a reference to the
  cache file, and the first batch arrives in 1.08 s. packmem pickles to 308 MB, which every worker copies,
  so the first batch takes 4.83 s. Node-wide peak PSS is 1.81 GB for HF against 2.76 GB for packmem.
- **Instant reload.** A reload from the existing cache takes 0.02 s warm and 0.19 s with a cold page cache.
  packmem's `load_json` takes 8.5 s on every start.
- **Batched and columnar access.** `ds[i:i+64]` costs 2.25 us per row, against packmem's slices at
  4.96 us per row. A pass with `ds.iter(batch_size=1000)` takes 2.0 s, against 2.8 s for packmem's `lazy()`
  pass and 3.8 s for its dict pass.
- **A compressed source format.** zstd parquet is 163.7 MB and builds the cache in 2.3 s.

What packmem does better:
- **Per-row Python access.** Random `x[i]` to a dict costs 6.05 us against HF's 22.2 us (3.7x). Random
  `x[i]['conversations']` costs 6.08 us against 21.0 us. A full sequential pass of dicts takes 3.75 s against
  10.2 s with HF's default `for r in ds`. DataLoader map-style datasets use exactly this per-row path.
- **Smaller resident footprint, with no files and no cache directory.** packmem holds 383 MB of RSS/USS
  after a pass, against HF B1's 915 MB of RSS, of which 749 MB is page cache. Compared with a fully
  in-memory HF dataset (B2, 971 MB anonymous), packmem is 2.5x smaller.
- **No conversion step and no schema work.** packmem took the file as-is, with mixed-type `id`, missing
  keys and one oddly shaped turn, and round-tripped every record bit-exactly. HF needed explicit Features
  that cover a rare nested field. With the default options it also **silently rewrote 158,383 ids**
  (see "HF loading traps").
- **The list replacement case.** packmem is the large win here: against the list under forkserver, node-wide
  peak PSS is 2.76 GB against 15.7 GB (5.7x), and the first batch arrives in 4.8 s against 38.6 s. Under fork
  it is 641 MB against 3,604 MB.

Surprises:
1. HF's JSON loader in `datasets` 5.2.0 silently corrupts mixed-type ids, even with `features={'id': Value('string')}`
   (details below). Passing `on_mixed_types=None` fails instead. Pre-writing the ids as strings was required.
2. The Arrow cache (785 MB) is smaller than the 1.03 GB JSON. Keys and escaping disappear, and the text
   dominates, so there is little left for a columnar encoder to win. packmem's further 2.55x comes from FSST
   string compression of the JSON-text conversations column (295 MB of its 308 MB).
3. HF's per-row `ds[i]` is the slow path, at 22 us. HF's own batched paths are faster than packmem.
4. On Linux, the list takes 2.9 GB RSS (tracemalloc 2.70 GB). The macOS `phys_footprint` figure from the
   earlier ml_swaps runs was 5.2 GB, so Linux list numbers are about half the macOS ones.

## Setup

- Host `linux-server`: AMD Ryzen 9 7950X3D (32 threads), 124 GiB RAM, Ubuntu 24.04, kernel 6.8.0-139-generic,
  Python 3.12.3. The host is shared with CI runners: 1-minute load ranged from 3 to 47 during the runs
  (every run's load is listed at the end).
- Venv: `python3 -m venv` (uv was not installed), pip 26.3.
- Packages: packmem **0.1.1** from PyPI,
  wheel `packmem-0.1.1-cp310-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl`,
  sha256 `34c1e283768e82250f13b735972316a47e8a372b01ba644a2b4cb72601a18617`; datasets **5.2.0**;
  pyarrow 26.0.1; huggingface_hub 2.4.0; numpy 2.5.4; psutil 7.2.2; torch 2.15.0+cpu
  (`--index-url https://download.pytorch.org/whl/cpu`).
- Data: `liuhaotian/LLaVA-Instruct-150K` / `llava_v1_5_mix665k.json`, 1,029,887,963 bytes,
  sha256 `ce959ce6e23073ee1cd1a8a2ef1c633768c10d4174327b8b2dc7113b91af6cf8`.
- Every measured process was run as
  `nice -n 10 systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 venv/bin/python -I scripts/<script> ...`
  (`scripts/run1.sh`). Before each run, `run1.sh` checks that `free -g` available is at least 30 GB above the
  expected peak, and it records the 1-minute load at start and end. Runs were strictly sequential. The
  highest measured peak was about 16 GB (list, forkserver), and available memory never fell below 88 GB.
- `HF_HOME=~/packmem-hfbench/hf`, `HF_DATASETS_CACHE=~/packmem-hfbench/hf/datasets`, and every `cache_dir=`
  pointed under `~/packmem-hfbench/hf/`.
- Page-cache control without sudo (`scripts/pcache.py`): `drop` runs `fsync` and then
  `os.posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED)`. `warm` reads the file. Both then verify residency with
  `mincore`. Before every cold run, the Arrow file was confirmed at 0.0% resident, and before every warm run
  at 100%.

### Commands

```
python3 -m venv venv
venv/bin/pip download --no-deps packmem==0.1.1 -d out/wheels && sha256sum out/wheels/*
venv/bin/pip install out/wheels/packmem-*.whl datasets pyarrow psutil
venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
python -c 'hf_hub_download("liuhaotian/LLaVA-Instruct-150K", "llava_v1_5_mix665k.json", repo_type="dataset", local_dir="data")'

S=scripts/run1.sh                                   # NAME EXPECTED_PEAK_GB SCRIPT ARGS
$S hash_A 8 bench_load.py A hash; $S hash_C 4 bench_load.py C hash
$S prep_ids 8 prep_ids.py                           # HF workaround input, see below
$S conv_B1_{1,2,3} 15 bench_load.py B1 conv hf/<fresh dir>   # 3rd one kept as hf/cache_B1
$S hash_B1 4 bench_load.py B1 hash hf/cache_B1
$S mkparquet 6 bench_load.py B1 mkparquet hf/cache_B1
$S conv_B3_{1,2,3} 10 bench_load.py B3 conv hf/<fresh dir>   # 3rd one kept as hf/cache_B3
$S hash_B3 4 bench_load.py B3 hash hf/cache_B3
$S conv_B4 15 bench_load.py B4 conv hf/cache_B4
scripts/run_all.sh load      # size_A, then 3 interleaved rounds of A, C, B1 warm, B1 cold, B2, B3 (full mode)
scripts/run_all.sh dl        # 3 rounds of {fork, forkserver} x {A, B1, C, E}
venv/bin/python -I scripts/summarize.py out
```

### Arms

| Arm | How it is loaded |
|---|---|
| A | `json.load(f)`, then `r["id"] = str(r["id"])` for every row |
| B1 | `load_dataset("json", data_files=mix665k.idstr.json, features=F, split="train", cache_dir=...)`, Arrow cache memory-mapped (default) |
| B2 | B1 with `keep_in_memory=True` (reads the existing cache into anonymous Arrow buffers) |
| B3 | B1 written once to zstd parquet, then `load_dataset("parquet", data_files=..., split="train")` |
| B4 | size only: B1 with `conversations: List(Json())` (stored as JSON text, as packmem does) |
| C | `packmem.load_json(path)`, then `t.set_column("id", [str(v) for v in t.column("id")])` |
| E | DataLoader floor: the same libraries imported, and every index returns one tiny constant record |

`F = Features({id: string, image: string, model: string, conversations: List({from: string, value: string,
text: string, markdown: {type: string, index: int64, answer: string}})})`

## HF loading traps, and the normalization

The data is messier than the task description suggested:
- `id`: 593,158 strings and 72,140 ints, with no collisions after `str()`.
- 624,610 records are `{id, image, conversations}`. 40,688 text-only records are `{id, model, conversations}`
  with `model == ""` and no `image`. The schema therefore needs `model` as well as `image`.
- One turn (record 650,962) has extra keys `text` (a string) and `markdown` (a dict `{type, index, answer}`).
  All 6,888,491 other turns are `{from, value}`. F declares both extra keys so that nothing is dropped.
- The file contains no JSON nulls.

**Trap: silent id corruption.** I loaded the original file with
`features=F` and the default `on_mixed_types="use_json"`. The conversion succeeds, but the JSON loader
detects mixed types in `id` and runs `json_encode_field` on that field. That function leaves strings that
already parse as JSON (the numeric COCO ids like `"000000033471"`) untouched and JSON-encodes everything
else. The cast to `Value("string")` then keeps the encoded text, so **158,383 ids** (every non-numeric id,
starting at index 364,100) come back with literal quotes and escaped slashes: `'VG_100K/4'` becomes
`'"VG_100K\\/4"'`, and `'i6IyJda_0'` becomes `'"i6IyJda_0"'`. There is no error or warning, and
`ds.features` says `id: string`. Evidence is in `out/conv_B0_origfile.json`, `out/hash_B0_origfile.json`
and `out/diff_B0_origfile.json`. That conversion took 45.6 s, with a peak RSS of 8.6 GB.
`on_mixed_types=None` raises `DatasetGenerationError` (`out/try_mixed_none.json`).

**Workaround used for every HF arm:** `scripts/prep_ids.py` rewrites the JSON once with `str(id)`, and
nothing else changes. It uses the same `indent=2` and ASCII escaping, takes 33.7 s once, and writes
`mix665k.idstr.json` at 1,030,032,243 bytes. This is the same `str(id)` normalization that A and C apply
in-process.

**Normalization for comparison:** every record is hashed as
`sha256(json.dumps(strip_none(record), sort_keys=True))`. `strip_none` recursively drops keys whose value is
`None`. HF fills every missing key with `None`: `image=None` on 40,688 records, `model=None` on 624,610
records, and `text=None, markdown=None` on 6,888,491 turns. The source has zero nulls, so dropping `None`
loses nothing. packmem keeps missing keys missing, as the list does. A and C also match without
`strip_none` (`raw_digest`).

**Correctness results:**
- Per-record canonical hashes are byte-identical across A, B1, B3 and C for all 665,298 records. The
  digest of the concatenated per-record hashes is `63938d0e8a06b842c2466902dedac56c9f4d693f87f8b22eab1f5d1e8047c8f8`.
- Raw (unstripped) hashes are identical between A and C.
- DataLoader batch digests are identical across A, B1 and C, for both start methods and all 18 runs:
  `debc5679...6578714f`.

## 1. Size (bytes; MB = 10^6)

| What | Bytes | MB |
|---|---|---|
| Source JSON | 1,029,887,963 | 1,029.9 |
| Source JSON with string ids (HF input) | 1,030,032,243 | 1,030.0 |
| **Arrow cache, B1** (`json-train.arrow`, one file) | **785,116,248** | **785.1** |
| Arrow cache, B3 (from parquet) | 785,116,248 | 785.1 |
| Arrow cache, B4 (conversations as `Json()` text) | 782,481,584 | 782.5 |
| Arrow cache from the original file (ids corrupted) | 785,520,168 | 785.5 |
| `ds.data.nbytes` (B1) / B2 `pa.total_allocated_bytes()` | 783,601,523 / 784,625,984 | 783.6 / 784.6 |
| Parquet, zstd (pyarrow `write_table`) | 163,712,516 | 163.7 |
| Parquet, HF `to_parquet` default (snappy, which HF pins per column) | 239,178,479 | 239.2 |
| **packmem `nbytes`** | **308,015,732** | **308.0** |
| packmem `len(pickle.dumps(table))` | 308,008,240 | 308.0 |
| Python list, tracemalloc delta after `json.load` / after id normalization | 2,703,346,737 / 2,704,782,143 | 2,703.3 / 2,704.8 |
| Python list, `len(pickle.dumps(rows))` | 687,449,519 | 687.4 |

packmem column breakdown (`describe()`): conversations 295.5 MB (JSON text, FSST), image 6.7 MB, id 5.8 MB,
model 6 KB. Ratios: Arrow/packmem = 2.55x; list/packmem = 8.8x; packmem/zstd-parquet = 1.88x.

## 2. Build and load time (s, median of 3 fresh processes)

| Step | Median | Runs | Load during runs |
|---|---|---|---|
| A `json.load` + id normalize | 4.59 + 0.13 | 4.57 / 4.59 / 6.32 | 3-15 |
| C `packmem.load_json` + id normalize | 8.46 + 0.18 | 8.43 / 8.46 / 15.33 | 3-29 |
| B1 first conversion (fresh cache dir) | 25.15 | 25.06 / 25.15 / 27.00 | 38-41 |
| B1 first conversion, peak RSS | 5.68 GB | | |
| B1 reload, warm page cache | 0.02 | 0.02 / 0.02 / 0.03 | 3-38 |
| B1 reload, cold page cache (Arrow file 0% resident) | 0.19 | 0.19 / 0.19 / 0.24 | 4-41 |
| B2 reload into memory (`keep_in_memory=True`) | 0.18 | 0.15 / 0.18 / 0.34 | 4-41 |
| B3 write zstd parquet from B1 (once) | 2.56 | | 42 |
| B3 first conversion from parquet | 2.28 | 2.26 / 2.28 / 2.32 | 43-45 |
| B3 first conversion, peak RSS | 1.60 GB | | |
| B3 reload, warm | 0.02 | | |
| B4 first conversion (`List(Json())`, 1 run) | 86.0 | | 44-46 |

packmem `load_json` takes 1.8x as long as `json.load`, matching the earlier 1.6-2x. The conversion rows ran
at load 38-46 and the reload rows at 3-9 for two of three rounds, so absolute numbers are not comparable
across those groups. The compressed parquet source makes the first build 11x faster (2.3 s against 25 s,
because it skips JSON parsing) and produces a byte-identical cache, as expected.

## 3. Memory in one process (MB, from `/proc/self/smaps_rollup`, median of 3)

USS = Private_Clean + Private_Dirty. "arrow Rss / Private" is the sum over mappings of `*.arrow` in `/proc/self/smaps`.

After load:

| Arm | Rss | Pss | USS | Private_Dirty | Private_Clean | Pss_Anon | Pss_File | arrow Rss | peak RSS |
|---|---|---|---|---|---|---|---|---|---|
| A list | 2,906 | 2,898 | 2,895 | 2,895 | 0 | 2,895 | 3 | 0 | 3,930 |
| B1 mmap (warm or cold) | 197 | 187 | 184 | 89 | 95 | 89 | 98 | 44 | 195 |
| B2 in-memory | 1,021 | 1,011 | 1,009 | 958 | 51 | 958 | 54 | 0 | 1,019 |
| B3 mmap | 197 | 187 | 184 | 89 | 95 | 89 | 98 | 44 | 194 |
| C packmem | 385 | 377 | 375 | 373 | 1 | 373 | 4 | 0 | 451 |

After a full pass over all rows:

| Arm | Rss | Pss | USS | Private_Dirty | Private_Clean | Pss_Anon | Pss_File | arrow Rss | peak RSS |
|---|---|---|---|---|---|---|---|---|---|
| A list | 2,908 | 2,900 | 2,898 | 2,898 | 0 | 2,898 | 3 | 0 | 3,930 |
| B1 mmap, warm | 915 | 905 | 903 | 102 | 801 | 102 | 804 | **749** | 936 |
| B1 mmap, cold | 913 | 903 | 900 | 102 | 799 | 102 | 802 | 747 | 930 |
| B2 in-memory | 1,036 | 1,025 | 1,023 | 971 | 52 | 971 | 55 | 0 | 1,055 |
| B3 mmap | 915 | 905 | 902 | 101 | 801 | 101 | 804 | 749 | 934 |
| C packmem | 394 | 386 | 383 | 382 | 1 | 382 | 4 | 0 | 460 |

How to read these numbers:
- For B1 and B3, **USS overstates private memory.** Linux counts a file page mapped by only one process as
  `Private_Clean`, even though it is page cache. It is clean, the kernel can drop and re-read it at any time,
  and it becomes `Shared_Clean` as soon as a second process maps the same page. The non-reclaimable private
  cost of HF is **Private_Dirty / Pss_Anon: 102 MB**, against packmem's 382 MB and the list's 2,898 MB.
  The Arrow pages, 749 MB of RSS after a pass (95% of the file), are the page-cache share. They are paid once
  per machine, however many processes map the file.
- For A, B2 and C, all memory is anonymous and private: Pss_Anon is about USS, and nothing is reclaimable.
- B2 shows that "Arrow in memory" costs 971 MB anonymous, which is 2.5x packmem.
- Library floor in these processes (interpreter plus imports): about 90 MB with datasets and pyarrow imported.

## 4. Access speed (median of 3, s for the stated count; us per op in parentheses)

| Op | A list | B1 warm | B1 cold | B2 | B3 | C packmem |
|---|---|---|---|---|---|---|
| 100k random `x[i]` to dict | 0.015 (0.15) | 2.216 (22.2) | 2.738 (27.4) | 2.350 (23.5) | 2.652 (26.5) | **0.605 (6.05)** |
| 20k random `x[i]['conversations']` | 0.005 (0.27) | 0.420 (21.0) | 0.465 (23.3) | 0.460 (23.0) | 0.523 (26.2) | **0.122 (6.08)** |
| 2,000 random `x[i:i+64]` (per row) | 0.001 (0.01) | **0.288 (2.25)** | 0.351 (2.74) | 0.310 (2.42) | 0.365 (2.85) | 0.635 (4.96) |
| full pass `for r in x: r['conversations'][0]['value']` | 0.166 | 10.17 | 10.30 | 11.42 | 10.68 | **3.75** |
| HF `for b in ds.iter(batch_size=1000)` pass | | **1.99** | 2.14 | 2.69 | 1.92 | |
| packmem `for r in t.lazy()` pass | | | | | | 2.77 |
| packmem 100k `t._t.rows_lazy(i, i+1)` (no decode) | | | | | | 0.021 |
| packmem 20k lazy `['conversations']` | | | | | | 0.164 |
| pickle dumps / loads | 7.46 / 2.67 | 0.000 / 0.008 | | | 0.000 / 0.012 | 0.41 / 0.31 |

Notes:
- A list's `x[i]` returns the existing dict without building one, so it is not comparable to the others.
- packmem has no public random-access lazy row. `lazy()` only iterates, so the lazy random numbers use the
  private `Table._t.rows_lazy(i, i+1)`. For a row whose cost is one JSON-text column, lazy random access is
  no faster than `t[i]` (8.2 us against 6.1 us).
- Cold against warm page cache for B1 makes little difference here (+24% on random rows). The NVMe RAID
  serves the 785 MB file fast, and the per-row Python conversion dominates.

## 5. DataLoader

The setup is map-style: `Holder(Dataset)` with `__len__` and `__getitem__` returning `x[i]`. It uses 4 workers,
`batch_size=8`, `sampler = random.Random(0).sample(range(665298), 20000)`, and `persistent_workers=True` so
the workers can be sampled at the end of the epoch. `collate` returns
`sha256("\x1e".join(from + "\x1f" + value))` for each record. A background thread reads
`/proc/<pid>/smaps_rollup` for the parent and every descendant every 0.5 s, and also samples explicitly
after the first batch and at the end of the epoch. "Workers" excludes the forkserver and resource_tracker
helpers, which are about 5 MB each but are included in the node-wide sums. MB, median of 3 runs; per-worker
ranges cover all 12 worker processes in the 3 runs. These runs were at load 3-14.

| Arm | Start | Node peak PSS sum | Node peak USS sum | Node peak Pss_Anon sum | Parent peak USS | Worker peak USS | Worker peak Private_Dirty | Worker arrow Rss | First batch s | 20k epoch s | Pickled dataset |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A list | fork | 3,604 | 3,115 | 3,528 | 3,115 | 119-121 | 119-121 | 0 | 0.20 | 0.94 | |
| B1 HF | fork | 994 | 378 | 269 | 378 | 50-53 | 12 | 406-407 | 0.02 | 0.35 | |
| C packmem | fork | 641 | 589 | 564 | 589 | 11 | 11 | 0 | 0.04 | 0.25 | |
| E floor | fork | 358 | 327 | 239 | 327 | 6 | 6 | 0 | 0.02 | 0.20 | |
| A list | forkserver | **15,725** | 15,648 | 15,647 | 3,813 | 3,026-3,293 | 3,026-3,293 | 0 | 38.63 | 39.50 | 687.5 MB |
| B1 HF | forkserver | **1,811** | 1,240 | 1,083 | 378 | 251-253 | 213 | 406-408 | 1.08 | 1.40 | **2.2 KB** |
| C packmem | forkserver | **2,762** | 2,684 | 2,683 | 897 | 463-769 | 463-769 | 0 | 4.83 | 5.09 | 308.0 MB |
| E floor | forkserver | 961 | 883 | 840 | 327 | 154 | 154 | 0 | 0.76 | 0.91 | 151 B |

Cost of the data above the floor (Pss_Anon sum minus E):

| | fork | forkserver |
|---|---|---|
| A list | +3,289 | +14,807 |
| B1 HF | **+30** | **+243** (about 60 MB per worker, mostly the pyarrow/datasets import) |
| C packmem | +325 | +1,843 (308 MB copy per worker, plus the parent pickling) |

How to read this table:
- Under fork, HF workers' USS of 50 MB includes about 39 MB of `Private_Clean` Arrow pages that only that
  worker happened to touch. Their truly private, dirty memory is 12 MB.
- Each HF worker has 406 MB of the Arrow mapping resident, but those pages are the same page-cache pages in
  every worker. PSS splits them, which is why HF's node PSS sum (994) is well above its anonymous sum (269).
- packmem fork workers stay at 11 MB, close to the 6 MB floor, because packed buffers carry no refcounts.
  The list's workers grow to 120 MB each after only 5k rows apiece, because refcount writes trigger
  copy-on-write. That grows with epoch length, and it was 2.8 GB per worker for a full epoch in the earlier
  macOS runs.
- packmem's forkserver worker peak of up to 769 MB is transient. One worker per run peaked at 729-768 MB
  while the pickled bytes and the rebuilt table were both alive. At the end of the epoch, every worker
  holds 462 MB.

## Caveats

- The host was shared. The 1-minute load was 20-47 during the correctness and conversion runs and the first
  load/access phase, and 3-41 during the rerun that the tables above use. The first phase's outputs are kept
  in `out/load_highload/`, and they reach the same conclusions with timings 1.2-1.9x slower (packmem random row to dict
  4.9x faster than HF there). The DataLoader runs
  were at 3-14. Conversion times (B1 25 s, B3 2.3 s, B4 86 s) were measured at load around 40 and are
  pessimistic.
- B1 cold: the cold page cache affects the reload (0.19 s against 0.02 s) and the first touches. Medians are
  from three fresh processes, each preceded by a verified `DONTNEED` drop. No other process had the file
  mapped.
- The DataLoader runs cover 20k samples (5k per worker), not a full epoch. The list's fork-worker growth,
  and HF's resident Arrow pages per worker, both grow with more samples. packmem's do not.
- A first DataLoader attempt without `persistent_workers` was stopped and discarded after 5 runs. The epochs
  are so short (0.2-1.3 s under fork) that workers exited before the 0.5 s sampler saw their final state.
- B2 pickling was not measured. `keep_in_memory` datasets pickle the whole table. B4 was a single run used
  only for size.
- HF's per-row `ds[i]` uses the default Python formatting. `with_format("arrow")` or batched `__getitems__`
  would be faster, but the DataLoader wrapper here, like most training code, calls `__getitem__` per index.
- The parquet zstd file was written with `pyarrow.parquet.write_table(ds.data.table, compression="zstd")`.
  HF's own `to_parquet(compression="zstd")` raises `TypeError: got multiple values for keyword argument
  'compression'`, because HF sets per-column snappy itself.
- The packmem lazy random-access numbers use a private method (`Table._t.rows_lazy`).

## Files

Kept: `~/packmem-hfbench/RESULT.md`, `~/packmem-hfbench/scripts/` (`common.py`, `bench_load.py`, `bench_dl.py`,
`dlcommon.py`, `pcache.py`, `prep_ids.py`, `diff_hf.py`, `try_mixed.py`, `run1.sh`, `run_all.sh`,
`summarize.py`) and `~/packmem-hfbench/out/` (the JSON outputs of every run, `runs.jsonl` with loads,
`summary.md`). Deleted: the data, venv, pip cache, wheel, HF caches, parquet and the per-record hash
files.

## Load averages per run (1-minute, start and end)

Run names match the files in `out/`. The `full_*` and `size_A` runs listed before the `load-rerun` marker are the
high-load first phase (`out/load_highload/`).

- conv_B0_origfile: rc=0, load 33.18 -> 29.78, wall 46.9 s, available 97 GB
- hash_A: rc=0, load 29.34 -> 26.56, wall 26.2 s, available 101 GB
- hash_C: rc=0, load 26.56 -> 26.38, wall 42.2 s, available 102 GB
- hash_B0_origfile: rc=0, load 26.38 -> 24.67, wall 23.6 s, available 97 GB
- diff_B0_origfile: rc=0, load 23.53 -> 23.0, wall 21.6 s, available 103 GB
- try_mixed_none: rc=0, load 25.23 -> 26.9, wall 31.6 s, available 103 GB
- prep_ids: rc=0, load 26.68 -> 37.66, wall 38.0 s, available 97 GB
- conv_B1_1: rc=0, load 38.33 -> 41.23, wall 26.9 s, available 93 GB
- conv_B1_2: rc=0, load 41.23 -> 40.97, wall 26.8 s, available 95 GB
- conv_B1_3: rc=0, load 40.97 -> 41.11, wall 28.6 s, available 93 GB
- hash_B1: rc=0, load 41.11 -> 46.9, wall 33.4 s, available 90 GB
- conv_B4: rc=0, load 46.48 -> 43.7, wall 87.7 s, available 88 GB
- mkparquet: rc=0, load 42.48 -> 43.49, wall 6.6 s, available 96 GB
- conv_B3_1: rc=0, load 43.49 -> 43.37, wall 3.7 s, available 95 GB
- conv_B3_2: rc=0, load 43.37 -> 43.37, wall 3.7 s, available 96 GB
- conv_B3_3: rc=0, load 43.37 -> 45.1, wall 3.6 s, available 97 GB
- hash_B3: rc=0, load 45.1 -> 43.03, wall 28.7 s, available 96 GB
- phase `load` started 2026-11-13T21:31:52+01:00
- size_A: rc=0, load 46.27 -> 45.48, wall 58.6 s, available 94 GB
- full_A_1: rc=0, load 45.2 -> 44.97, wall 48.8 s, available 94 GB
- full_C_1: rc=0, load 44.97 -> 45.63, wall 41.0 s, available 95 GB
- full_B1warm_1: rc=0, load 45.63 -> 42.46, wall 28.0 s, available 98 GB
- full_B1cold_1: rc=0, load 42.46 -> 37.08, wall 24.8 s, available 100 GB
- full_B2_1: rc=0, load 37.08 -> 35.88, wall 22.7 s, available 106 GB
- full_B3_1: rc=0, load 35.88 -> 32.79, wall 20.6 s, available 105 GB
- full_A_2: rc=0, load 32.79 -> 27.75, wall 29.5 s, available 104 GB
- full_C_2: rc=0, load 27.75 -> 23.8, wall 21.8 s, available 104 GB
- full_B1warm_2: rc=0, load 23.74 -> 23.24, wall 19.4 s, available 106 GB
- full_B1cold_2: rc=0, load 23.24 -> 22.35, wall 21.6 s, available 104 GB
- full_B2_2: rc=0, load 22.35 -> 22.63, wall 24.6 s, available 104 GB
- full_B3_2: rc=0, load 22.63 -> 22.14, wall 21.6 s, available 103 GB
- full_A_3: rc=0, load 22.14 -> 22.12, wall 31.0 s, available 104 GB
- full_C_3: rc=0, load 22.12 -> 22.61, wall 23.8 s, available 102 GB
- full_B1warm_3: rc=0, load 22.61 -> 20.76, wall 20.3 s, available 102 GB
- full_B1cold_3: rc=0, load 20.76 -> 22.02, wall 22.2 s, available 100 GB
- full_B2_3: rc=0, load 22.02 -> 20.92, wall 20.5 s, available 105 GB
- full_B3_3: rc=0, load 20.92 -> 21.16, wall 20.0 s, available 105 GB
- phase `dl` started 2026-11-13T21:41:23+01:00
- phase `dl` started 2026-11-13T21:42:25+01:00 (restarted with persistent_workers=True)
- dl_A_fork_1: rc=0, load 13.7 -> 13.49, wall 13.5 s, available 107 GB
- dl_B1_fork_1: rc=0, load 13.49 -> 12.97, wall 3.4 s, available 107 GB
- dl_C_fork_1: rc=0, load 12.97 -> 12.26, wall 12.8 s, available 109 GB
- dl_E_fork_1: rc=0, load 12.26 -> 11.84, wall 2.7 s, available 110 GB
- dl_A_forkserver_1: rc=0, load 11.84 -> 8.34, wall 63.5 s, available 110 GB
- dl_B1_forkserver_1: rc=0, load 8.34 -> 8.34, wall 3.5 s, available 114 GB
- dl_C_forkserver_1: rc=0, load 8.34 -> 8.96, wall 15.7 s, available 114 GB
- dl_E_forkserver_1: rc=0, load 8.96 -> 8.96, wall 2.8 s, available 113 GB
- dl_A_fork_2: rc=0, load 8.96 -> 7.81, wall 10.6 s, available 114 GB
- dl_B1_fork_2: rc=0, load 7.81 -> 7.43, wall 2.7 s, available 112 GB
- dl_C_fork_2: rc=0, load 7.43 -> 6.96, wall 11.0 s, available 113 GB
- dl_E_fork_2: rc=0, load 6.96 -> 7.12, wall 2.4 s, available 113 GB
- dl_A_forkserver_2: rc=0, load 7.12 -> 4.74, wall 55.7 s, available 114 GB
- dl_B1_forkserver_2: rc=0, load 4.74 -> 4.74, wall 3.7 s, available 112 GB
- dl_C_forkserver_2: rc=0, load 4.74 -> 3.68, wall 15.8 s, available 113 GB
- dl_E_forkserver_2: rc=0, load 3.68 -> 3.68, wall 3.0 s, available 112 GB
- dl_A_fork_3: rc=0, load 3.68 -> 3.43, wall 10.2 s, available 113 GB
- dl_B1_fork_3: rc=0, load 3.43 -> 3.55, wall 2.4 s, available 114 GB
- dl_C_fork_3: rc=0, load 3.55 -> 3.24, wall 10.4 s, available 114 GB
- dl_E_fork_3: rc=0, load 3.24 -> 3.24, wall 2.2 s, available 114 GB
- dl_A_forkserver_3: rc=0, load 3.24 -> 2.65, wall 55.2 s, available 114 GB
- dl_B1_forkserver_3: rc=0, load 2.65 -> 2.6, wall 3.6 s, available 111 GB
- dl_C_forkserver_3: rc=0, load 2.6 -> 3.8, wall 16.1 s, available 113 GB
- dl_E_forkserver_3: rc=0, load 3.8 -> 3.58, wall 3.0 s, available 112 GB
- phase `load-rerun` started 2026-11-13T21:47:55+01:00 (rerun at lower load; the first load phase (load 20-46) is kept in out/load_highload)
- size_A: rc=0, load 3.58 -> 3.01, wall 22.1 s, available 113 GB
- full_A_1: rc=0, load 3.01 -> 3.22, wall 20.3 s, available 114 GB
- full_C_1: rc=0, load 3.22 -> 3.42, wall 17.7 s, available 113 GB
- full_B1warm_1: rc=0, load 3.42 -> 4.73, wall 15.7 s, available 111 GB
- full_B1cold_1: rc=0, load 4.73 -> 4.06, wall 15.4 s, available 111 GB
- full_B2_1: rc=0, load 4.06 -> 3.92, wall 14.8 s, available 113 GB
- full_B3_1: rc=0, load 3.92 -> 3.78, wall 14.9 s, available 113 GB
- full_A_2: rc=0, load 3.78 -> 3.05, wall 19.3 s, available 113 GB
- full_C_2: rc=0, load 3.05 -> 2.97, wall 16.9 s, available 112 GB
- full_B1warm_2: rc=0, load 2.97 -> 3.57, wall 15.6 s, available 113 GB
- full_B1cold_2: rc=0, load 3.57 -> 4.42, wall 17.3 s, available 112 GB
- full_B2_2: rc=0, load 4.42 -> 6.23, wall 18.1 s, available 108 GB
- full_B3_2: rc=0, load 6.85 -> 8.92, wall 17.2 s, available 110 GB
- full_A_3: rc=0, load 8.92 -> 15.17, wall 30.1 s, available 104 GB
- full_C_3: rc=0, load 15.17 -> 29.45, wall 35.0 s, available 100 GB
- full_B1warm_3: rc=0, load 29.45 -> 37.76, wall 27.5 s, available 88 GB
- full_B1cold_3: rc=0, load 37.76 -> 41.1, wall 30.7 s, available 92 GB
- full_B2_3: rc=0, load 41.1 -> 38.13, wall 25.0 s, available 94 GB
- full_B3_3: rc=0, load 38.13 -> 33.25, wall 25.4 s, available 93 GB
