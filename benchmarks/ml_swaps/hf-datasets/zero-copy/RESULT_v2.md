# DataLoader rerun with packmem zero-copy v2 (`share()`, `save()` + `open()`): LLaVA-1.5 mix665k on Linux

> **Measured on the pre-release zero-copy branch, not on the published 0.2.0.** Mac: branch `wip/zero-copy-v2` at 3fa7264 (wheel f9f57281…) for "share v2"/"open v2"; Linux: 3fa7264 (wheel ea2962bf…) and 7de0b93 (v2b, wheel 8cf7725a…). Loader figures are one training process's data loader with 4 workers, annotations only, no model and no GPU — not "per GPU node". The 22.7 GB list figure is the list arm of the 20k-sample spawn run.


This follow-up to `RESULT.md` reruns the DataLoader section (fork and forkserver) on the same host, with the same data,
harness and correctness checks. It adds packmem's zero-copy v2 arms. Every arm, including the old ones, was rerun on the
same day for comparability.

**v2 is a work-in-progress build.** It is branch `wip/zero-copy-v2`, commit `3fa72645cdb4b815d08b2538327afe514fa22c42`
(one commit on top of `d81ad22`), built here for measurement only. It is not a release. Its file format and pickle
layout belong to that commit only. The wheel still reports version `0.1.1`, the same version string as the PyPI 0.1.1
it is incompatible with.

## Verdict

**On the forkserver row, v2 beats HF on node PSS and on time to first batch in every v2 variant. On anonymous memory
above the floor, only `save()` + `open()` beats HF. `share()` loses that column, because the parent keeps its own
private copy of the table.**

Forkserver, 4 workers, MB, median of 3. Same-day runs at 1-minute load 26-37.

| | node peak PSS sum | anon above import-matched floor | anon above the E floor (as in RESULT.md) | first batch s | pickled per worker |
|---|---|---|---|---|---|
| HF Arrow mmap (B1) | 1,810 | +243 | +243 | 1.89 | 2,230 B |
| packmem 0.1.1, plain pickle (C) | 2,667 | +1,804 | +1,749 | 8.35 | 308.0 MB |
| **v2 `share()` to /dev/shm (V2S)** | **1,509** (1,543 counting the whole tmpfs file) | +371 | +315 | **1.21** | **136 B** |
| v2 `share(dir=disk)` (V2D) | 1,510 | +372 | +316 | 1.45 | 164 B |
| **v2 `save()` once, then `packmem.open()` (V2O)** | **1,144** | **+5** | -50 | 1.33 | **134 B** |
| floor, constant records, same imports as B1 (E) | 961 | | | 1.31 | 151 B |
| floor, no datasets/pyarrow, as for list/packmem (E0) | 863 | | | 1.42-1.50 | 151 B |

- **Node PSS:** V2S is 17% below HF, and 16% below it even when the whole 309 MB tmpfs file is counted as RAM. V2O is
  37% below HF. 0.1.1 was 47% above HF.
- **Anonymous memory above the floor:** V2O beats HF (+5 MB against +243 MB). V2S and V2D lose (+371 against +243).
  Their workers add about 1 MB anonymous each, against about 59 MB for each HF worker, but the parent still holds the
  308 MB table it loaded from JSON. `share()` writes a second copy to the file and keeps the in-memory one. Parent peak
  USS is 594 MB for V2S, 245 MB for V2O and 379 MB for HF.
- **First batch:** all three v2 variants (1.2-1.5 s) are at the floor (1.3-1.5 s) and below HF (1.89 s). 0.1.1 took 8.35 s.
  The host load was 26-37, against 3-14 in RESULT.md, so absolute times are about 1.5-2x the earlier ones (HF 1.89 against
  1.08). The ranking matches. The gaps between the v2 variants are within noise.
- **Fork row:** V2O again has the lowest node PSS of any data arm (549 MB against HF 994 and packmem 0.1.1 642), with
  anonymous memory +4 MB above the matched floor (HF +30).

The other two questions:
- **Size:** the Arrow cache is 785.1 MB (785,116,248 B). The packmem v2 file is 308.7 MB (308,680,442 B): the same
  for `share()` and `save()`, and equal to `to_bytes()`. That is **2.54x smaller**, essentially unchanged from 0.1.1's
  2.55x (308.0 MB). It still misses the 3x bar from RESULT.md. Each worker touches 176 MB of the .pkm against 407 MB of
  the .arrow for the same 5k rows, so the page-cache working set is 2.3x smaller.
- **Per-row access:** re-checked the same day at load 31-38. packmem random `x[i]` to dict is **4.0x faster than HF**
  (9.3 us against 37.5 us; 3.7x in RESULT.md). The memory-mapped `open()` table is as fast as an in-memory 0.1.1 table
  (9.38 against 9.31 us). HF's 64-row slices remain faster per row (4.5 us against 7.5 us).

## Linux test results for the v2 build (before measuring)

- `python/tests/test_paths.py` + `python/tests/test_properties.py` (pytest 9.2.0, hypothesis 6.170.15), run from a
  copy of the tests directory against the installed wheel (`packmem.__file__` in venv2 site-packages):
  **19 passed in 81.9 s**. No `/dev/shm/packmem-*` files before or after.
- `python/tests/test_packmem.py` is a script with no pytest tests, so pytest collects nothing. Run as a script, it printed
  `ok: 270000 rows, 13 columns, 8.6 MB packed` (rc 0).
- Full-table correctness on the real data: the per-record canonical and raw digests of all 665,298 records are
  `63938d0e8a06b842…8047c8f8` for v2 `load_json` (`hash_C_v2`), for v2 `packmem.open()` of the saved file
  (`hash_V2O`, reading through the mapping), for 0.1.1 (`hash_C`) and for HF (`hash_B1`, canonical). They are identical
  to the list's digests from RESULT.md. `packmem.open(path) == t` returned True.

## Build provenance

- Source: `git clone --branch wip/zero-copy-v2 https://github.com/HamedMP/packmem`, and `git rev-parse HEAD` printed
  `3fa72645cdb4b815d08b2538327afe514fa22c42`.
- Toolchain: rustup minimal in `~/packmem-hfbench/rust` (`RUSTUP_HOME`/`CARGO_HOME`), rustc 1.100.0 (0ef1bc386 2026-11-09),
  maturin 1.16.0. Built with `maturin build --release -o dist` in `python/`.
- Wheel: `packmem-0.1.1-cp310-abi3-manylinux_2_34_x86_64.whl`, sha256
  `ea2962bff60ed4cd025da45908ac774a21031a2db584ca7749e8e59444f22987`, installed only in its own `venv2`.
  0.1.1 from PyPI (sha256 `34c1e283…a18617`, the same as before) is in `venv`. No 0.1.1 pickle or file ever reached
  the v2 venv, or the other way round. Each run is one fresh process in one venv, and the v2 files are written and
  read only by venv2 processes.
- Both venvs: Python 3.12.3, datasets 5.2.0, pyarrow 26.0.1, numpy 2.5.4, psutil 7.2.2, torch 2.15.0+cpu.
- Data: the same `llava_v1_5_mix665k.json`, re-downloaded and verified (sha256 `ce959ce6e23073ee1cd1a8a2ef1c633768c10d4174327b8b2dc7113b91af6cf8`).
  The HF cache was rebuilt from `prep_ids.py`'s string-id file, giving a byte-identical size of 785,116,248.

## Arms

| Arm | venv | Parent loads with | Dataset sent to workers |
|---|---|---|---|
| A | 0.1.1 | `json.load` + `str(id)` | list (pickled under forkserver) |
| B1 | 0.1.1 | `load_dataset("json", ..., features=F)`, memory-mapped Arrow cache, warmed | HF pickles as a reference to the cache file |
| C | 0.1.1 | `packmem.load_json` + `set_column("id", str)` | full packed pickle (308 MB) |
| V2S | v2 | as C, then `t.share()`: written to `/dev/shm/packmem-<pid>-<hex>.pkm` | `_attach(path, size)`; workers mmap and read in place |
| V2D | v2 | as C, then `t.share(dir=~/packmem-hfbench/pkmshare)` | as V2S, but a disk file in the page cache |
| V2O | v2 | `packmem.open(~/packmem-hfbench/pkm/mix665k.pkm)`, written once by `prep_v2save.py`, warmed | as V2S; the parent also reads in place |
| E / E2 | each | constant record; imports datasets, pyarrow and packmem (the RESULT.md floor) | |
| E0 / E0v2 | each | constant record; imports packmem only | |

E0 is new. The E floor's parent imports datasets and pyarrow, which the list and packmem parents never import, and that
accounts for about 55 MB of anonymous memory in the parent. "Import-matched floor" uses E for B1 and E0 for A, C and the
v2 arms. Workers are 154 MB anonymous under forkserver with either floor. HF workers are 213 MB, from importing pyarrow
and datasets to unpickle the dataset.

The harness is the same as before: map-style `Holder`, 4 workers, `batch_size=8`, 20k indices from
`random.Random(0).sample`, `persistent_workers=True`, smaps sampled every 0.5 s and at the first batch and end of epoch.
`scripts/bench_dl2.py` is `bench_dl.py` plus: per-mapping `Rss / Pss / Shared_Clean / Private_Clean / Shared_Dirty /
Private_Dirty` for `.pkm` and `.arrow` mappings, `Pss_Shmem`, the shared file's path, size and mode, and the pickled
size for every forkserver arm and every v2 arm.

## DataLoader tables (MB = 10^6 B, median of 3; per-worker ranges cover all 12 workers in 3 runs)

### forkserver

| Arm | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled per worker |
|---|---|---|---|---|---|---|---|---|---|---|
| A list | 16,228 | | 16,150 | +15,310 | +15,366 | 0 | 3,808 | 81.34 | 84.48 | 687.4 MB |
| B1 HF | 1,810 | | 1,083 | +243 | +243 | 0 | 379 | 1.89 | 2.80 | 2,230 B |
| C 0.1.1 | 2,667 | | 2,589 | +1,749 | +1,804 | 0 | 897 | 8.35 | 9.10 | 308.0 MB |
| V2S | 1,509 | 1,543 | 1,156 | +315 | +371 | 275 | 594 | 1.21 | 1.70 | 136 B |
| V2D | 1,510 | | 1,157 | +316 | +372 | 0 | 595 | 1.45 | 2.08 | 164 B |
| V2O | 1,144 | | 790 | -50 | +5 | 0 | 245 | 1.33 | 1.95 | 134 B |
| E / E2 | 961 / 961 | | 840 / 840 | | | 0 | 327 | 1.31 / 1.41 | 1.88 / 1.96 | 151 B |
| E0 / E0v2 | 863 / 863 | | 785 / 785 | | | 0 | 228 | 1.50 / 1.42 | 2.04 / 1.97 | 151 B |

Per worker (peaks over the run):

| Arm | worker USS | worker PSS | worker Private_Dirty | worker Pss_Anon |
|---|---|---|---|---|
| A | 3,026-3,293 | 3,041-3,307 | 3,026-3,293 | 3,026-3,293 |
| B1 | 251-256 | 385-387 | 213 | 213 |
| C | 463-465 | 478-497 | 463 | 463 |
| V2S | 170-178 | 238-240 | 170-178 | 155 |
| V2D | 170-172 | 238-240 | 156-172 | 155 |
| V2O | 170-172 | 237-239 | 155 | 155 |
| floors | 154 | 169 | 154 | 154 |

Resident shared-file pages per worker (end of epoch, from `/proc/<pid>/smaps`):

| Arm | file | map Rss | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss |
|---|---|---|---|---|---|---|---|
| B1 | `json-train.arrow` (785 MB) | 407-408 | 367-369 | 38-41 | 0 | 0 | 148-150 |
| V2S | `/dev/shm/packmem-*.pkm` (309 MB) | 175-178 | 0 | 0 | 160-161 | 15-17 | 68-70 |
| V2D | `pkmshare/packmem-*.pkm` (309 MB) | 175-178 | 0-161 | 0-17 | 0-161 | 0-17 | 68-70 |
| V2O | `pkm/mix665k.pkm` (309 MB) | 175-178 | 160-161 | 15-17 | 0 | 0 | 67-69 |

### fork

| Arm | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above matched floor | parent peak USS | first batch s | 20k epoch s |
|---|---|---|---|---|---|---|---|---|
| A list | 3,605 | | 3,528 | +3,289 | +3,335 | 3,115 | 0.51 | 3.37 |
| B1 HF | 994 | | 269 | +30 | +30 | 378 | 0.06 | 0.97 |
| C 0.1.1 | 642 | | 564 | +325 | +371 | 589 | 0.10 | 0.77 |
| V2S | 649 | 958 | 572 | +333 | +379 | 595 | 0.11 | 0.75 |
| V2D | 650 | | 573 | +333 | +379 | 595 | 0.10 | 0.76 |
| V2O | 549 | | 197 | -42 | +4 | 245 | 0.03 | 0.44 |
| E / E2 | 358 | | 239 | | | 327 | 0.04 / 0.05 | 0.56 / 0.55 |
| E0 / E0v2 | 270 | | 193 | | | 228 | 0.07 / 0.05 | 0.49 |

| Arm | worker USS | worker PSS | worker Private_Dirty | worker Pss_Anon | worker map Rss / Shared_Clean / Private_Clean |
|---|---|---|---|---|---|
| A | 120 | 724 | 120 | 721-722 | |
| B1 | 50-55 | 205-206 | 12 | 53-54 | arrow 406-407 / 367-368 / 38-41 |
| C | 11 | 115-154 | 11 | 112-151 | |
| V2S | 11-12 | 117 | 11-12 | 114 | none (inherited anonymous table) |
| V2D | 11-13 | 117-189 | 11-12 | 114-185 | none (inherited anonymous table) |
| V2O | 24-27 | 109-111 | 9 | 39-40 | pkm 175-178 / 159-161 / 15-17 |
| floors | 6-8 | 41-58 | 6-8 | 38-55 | |

Under fork, `share()` makes no difference. Workers inherit the parent's anonymous table by copy-on-write and never
open the file, so V2S and V2D behave like C. The file costs 309 MB of tmpfs for nothing in the V2S case.

### Shared and saved files

| Arm | Location | Size | Mode | Time to write | Removed |
|---|---|---|---|---|---|
| V2S | `/dev/shm/packmem-<pid>-<16 hex>.pkm` (tmpfs) | 308,680,442 B | **0600** | `share()` 0.15-0.17 s | yes, at parent exit; 0 files left after every run |
| V2D | `~/packmem-hfbench/pkmshare/packmem-<pid>-<16 hex>.pkm` (ext4 on md RAID) | 308,680,442 B | **0600** | `share()` 0.25 s | yes, at parent exit |
| V2O | `~/packmem-hfbench/pkm/mix665k.pkm` (ext4) | 308,680,442 B | **0664** (umask) | `save()` 0.26 s once; `open()` 3 ms | it is a user file; sha256 `67da8f3a…1a1a` |

The saved file is not 0600. `save()` calls `write_file(tmp, False)`, which skips the owner-only mode, so it follows the
umask. That looks deliberate, since a saved file is the user's own path, but it differs from the "should be 0600"
expectation. Only `share()` files are 0600.

## How to read the v2 numbers

- **tmpfs pages count as Dirty, not Clean.** In V2S, each worker's .pkm mapping shows 160 MB `Shared_Dirty` and
  15-17 MB `Private_Dirty`, with zero `Clean`. tmpfs pages have no backing store, so the kernel always reports them
  dirty. They are shared memory (`Pss_Shmem`), not anonymous memory. As a result, the per-worker `Private_Dirty` and USS
  for V2S (170-178) include those 15-17 MB of tmpfs pages that only that worker happened to touch. The worker's real
  anonymous memory is `Pss_Anon` = 155 MB, which is the 154 MB floor plus 1 MB.
- **V2D is a mix.** The file was written moments before the workers mapped it. Pages still in writeback show as Dirty
  and pages already written back show as Clean, so the split varies by run (0-161). After writeback it is the V2O
  picture: `Shared_Clean` plus `Private_Clean` page cache.
- **V2O matches HF's model exactly:** clean, file-backed, reclaimable page cache shared across processes. It holds
  160 MB `Shared_Clean` and 15-17 MB `Private_Clean` per worker, against HF's 367 MB and 38-41 MB. The parent never
  builds a table. After `open()`, the parent's Pss_Anon is 12 MB in a bare process (`full_V2O`), against 373 MB for a
  0.1.1 `load_json` and 89 MB for HF.
- **"node peak incl. whole tmpfs file"** (V2S only) replaces the mapped share of the .pkm (Pss) with the full 309 MB
  file. A tmpfs file is RAM whether or not anyone maps it. The disk-backed files (Arrow, V2D, V2O) are reclaimable page
  cache and are counted by mapped PSS only, as in RESULT.md.
- **What still costs memory in V2S and V2D is the parent.** After `share()`, the parent keeps its own 308 MB packed table
  (`Private_Dirty` 522 MB after load, against 157 MB for V2O). The file is a second copy. If `share()` re-pointed the
  parent's own table at the file, or if the user saves once and opens it (V2O), the anonymous cost drops to the floor.
  That is the gap between +371 and +5.

## Per-row access re-check (one process, no DataLoader; s, median of 3; us per op)

The same `bench_load.py full` as RESULT.md, run at load 31-38.

| Op | B1 HF (warm) | C packmem 0.1.1 | V2O v2 `open()` |
|---|---|---|---|
| 100k random `x[i]` to dict | 3.753 (37.5) | **0.931 (9.31)** | **0.938 (9.38)** |
| 20k random `x[i]['conversations']` | 0.818 (40.9) | **0.173 (8.64)** | 0.185 (9.26) |
| 2,000 random `x[i:i+64]` (per row) | **0.575 (4.49)** | 1.013 (7.92) | 0.964 (7.53) |
| full pass `r['conversations'][0]['value']` (per row) | 14.59 (21.9) | **8.39 (12.6)** | 8.41 (12.6) |
| pickled size | 2,197 B | 308,008,240 B | 101 B |
| after the pass: Pss_Anon / USS / Rss | 103 / 903 / 916 | 382 / 383 / 394 | **29** / 339 / 350 |

Against HF, packmem is 4.0x faster on random row to dict (RESULT.md: 3.7x), 4.4-4.7x on `['conversations']`, and 1.7x on
the full pass. All of these are slower in absolute terms than in RESULT.md (HF 37.5 us against 22.2 us), because of the
host load. For V2O after a full pass, USS of 339 MB is mostly `Private_Clean` file pages that only this one process
mapped. As with HF's 903 MB, it is reclaimable page cache. The non-reclaimable memory is the 29 MB of Pss_Anon.

## Caveats

- The host was busier than in RESULT.md's DataLoader phase: 1-minute load 26-69 during the DataLoader runs (one spike to 69
  at `dl_E_fork_1`, otherwise 26-39), against 3-14 before. The memory figures reproduce the earlier run to within a few MB
  (B1 forkserver 1,810 against 1,811; C 2,667 against 2,762; the list under fork 3,605 against 3,604). The timings are
  1.5-2x slower, and differences under about 0.3 s in first-batch time are noise.
- 20k samples (5k per worker), not a full epoch. Each worker's resident .pkm pages (176 MB, 57% of the file) and .arrow pages
  (407 MB, 52%) grow toward the full file size with longer epochs. Being file pages, they stay shared.
- The v2 `load_json` median was 10.1 s, against 13.5 s for 0.1.1 in the same runs. That is under load, and it was not a
  goal of this run.
- `share()` makes the parent's table read-only (`frozen`) until `unshare()`. Workers get read-only `_attach` tables.
- The v2 wheel reports version `0.1.1`, so pip would treat it as the same version as the PyPI release, whose byte
  layout differs. It should get a distinct version before anyone installs it outside an isolated venv.

## Files

Kept in `~/packmem-hfbench/`: `RESULT.md` and `out/` (unchanged), this `RESULT_v2.md`, `out2/` (every run's JSON and
stderr, `runs.jsonl` with loads, `/dev/shm` counts and available memory per run, `summary_dl.md`, `setup.log`,
`build.log`, `prep.log`), and `scripts/`. New scripts: `bench_dl2.py`, `prep_v2save.py`, `run2.sh`, `run_all2.sh`,
`summarize2.py`, `setup2.sh`, `build_v2.sh` and `prep2.sh`. `common.py` gained the V2S/V2D/V2O/E0 arms, `file_maps()`
and `Pss_Shmem`. `bench_load.py` treats the v2 arms like C. Old arms behave as before.

Deleted: data, both venvs, the pip cache, HF caches, the rustup/cargo toolchain and target directory, the source clone,
the v2 wheel and the 0.1.1 wheel, the saved .pkm, the test copies. `packmem.cleanup_stale()` was run, and
`ls /dev/shm/packmem-*` matched nothing.

## Load averages per run (1-minute, start -> end)

See `out2/runs.jsonl`. Summary: prep 28.9-36.4. DataLoader phase (00:34-00:49): 26.3-69.4, median about 31. Floor E0 phase
31.9-35.1. Access phase 31.2-37.7. Available memory was 93-105 GB before every run, and every run had rc=0. Every run
started and ended with 0 `/dev/shm/packmem-*.pkm` files.

---

## v2b: `share()` re-attaches the parent (wip/zero-copy-v2 @ 7de0b93)

The core session changed `share()`. After writing the file, the sharing process now attaches to it
(`self._t = _Table.attach(path, size)`) and drops its own buffers, so it should behave like `save()` + `open()`.
I reran only the v2 arms with that build: `share()` to /dev/shm under fork and forkserver, `save()` + `open()` under
forkserver as the control, and the import-matched floor E0 on the same build (6 short runs, so that "above floor" does
not come from a different build). HF Arrow and packmem 0.1.1 numbers are from the runs above (same host, same harness,
about 30 minutes earlier).

**Still a work-in-progress build.**
- Source: `wip/zero-copy-v2`, `git rev-parse HEAD` = `7de0b9396b44cd253aeb22d33248a6fe8c1b01e4`
  ("Let the sharing process read from the shared file too", on top of `41ad076 Version 0.1.2`).
- Wheel: `packmem-0.2.0.dev0-cp310-abi3-manylinux_2_34_x86_64.whl`, sha256
  `8cf7725afaa728333566ba56147e695aedfaefc6e7fd2765390d6d2f2cc58b51`. rustc 1.100.0 and maturin 1.16.0 in
  `~/packmem-hfbench/rust`. Installed in its own `venv2b`, with the same library versions as before.
- `packmem.__version__` is now `0.2.0.dev0`, which settles the version-string caveat above.
- Data re-downloaded; sha256 `ce959ce6e23073ee1cd1a8a2ef1c633768c10d4174327b8b2dc7113b91af6cf8` matches.
- The id-normalized JSON (`prep_ids.py`) was not rebuilt. It is the input for the HF arms only, and none were rerun.
  The packmem arms read the original file and run `set_column("id", str)` in-process, exactly as before.

### Tests and correctness
- `test_paths.py` + `test_properties.py`: **19 passed** (84.5 s). `test_packmem.py` run as a script printed
  `ok: 270000 rows, 13 columns, 8.6 MB packed`. No `/dev/shm/packmem-*` files before or after.
- The full-table per-record digests through the new `share()` path (the parent iterating its re-attached table,
  `hash_V2S`) and through `open()` (`hash_V2O`) are both `63938d0e…8047c8f8`, identical to every earlier arm.
- The DataLoader batch digest is `debc5679…6578714f` in all 9 data runs.
- The saved file is byte-identical to the 3fa7264 build's (sha256 `67da8f3a…1a1a`, 308,680,442 B).
- The share file is mode 0600 in /dev/shm. Every run started and ended with 0 `/dev/shm/packmem-*.pkm` files.

### Results (MB, median of 3; load 21-37)

| Arm | start | node peak PSS sum | incl. whole tmpfs file | node Pss_Anon sum | anon above matched floor | parent peak USS | first batch s | 20k epoch s | pickled |
|---|---|---|---|---|---|---|---|---|---|
| HF Arrow mmap (earlier run) | forkserver | 1,810 | | 1,083 | +243 | 379 | 1.89 | 2.80 | 2,230 B |
| v2 `share()`, 3fa7264 (earlier run) | forkserver | 1,509 | 1,543 | 1,156 | +371 | 594 | 1.21 | 1.70 | 136 B |
| **v2b `share()`** | forkserver | **1,223** | 1,257 | 870 | **+85** | **324** | 1.21 | 1.61 | 136 B |
| v2b `save()` + `open()` | forkserver | 1,144 | | 790 | +6 | 245 | 0.99 | 1.50 | 134 B |
| E0 floor, v2b | forkserver | 864 | | 785 | | 228 | 1.13 | 1.46 | 151 B |
| packmem 0.1.1 (earlier run) | fork | 642 | | 564 | +371 | 589 | 0.10 | 0.77 | |
| v2 `share()`, 3fa7264 (earlier run) | fork | 649 | 958 | 572 | +379 | 595 | 0.11 | 0.75 | |
| **v2b `share()`** | fork | **634** | 668 | 282 | **+89** | **324** | 0.03 | 0.50 | |
| E0 floor, v2b | fork | 270 | | 193 | | 228 | 0.04 | 0.34 | |

Per worker:

| Arm | start | worker USS | worker PSS | worker Private_Dirty | worker Pss_Anon | .pkm map Rss | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty |
|---|---|---|---|---|---|---|---|---|---|---|
| v2b `share()` | forkserver | 170-178 | 237-239 | 170-178 | 155 | 175-178 | 0 | 0 | 160-161 | 15-17 |
| v2b `open()` | forkserver | 170-178 | 237-239 | 155 | 155 | 175-178 | 160-161 | 15-17 | 0 | 0 |
| v2b `share()` | fork | 26-27 | 126-128 | 26-27 | 56 | 175-178 | 0 | 0 | 160-161 | 15-17 |
| E0 floor | forkserver / fork | 154-156 / 8 | 169-171 / 41 | 154 / 8 | 154 / 38 | | | | | |

### Against the expectations
- **forkserver, anon above floor near +5:** not met. It is **+85**, down from +371. Workers are at the floor (155 MB
  Pss_Anon, as with `open()`). All of the remaining gap is in the parent.
- **forkserver, parent USS near 245 MB:** not met. It is **324 MB** (`open()` 245). The parent's Pss_Anon after load is
  237 MB, against 157 MB for `open()`.
- **fork, no worse than 0.1.1 (642 / +371):** met. It is **634 MB / +89**. Fork workers now map the file (176 MB of
  .pkm Rss each) instead of inheriting an anonymous table. Their Pss_Anon of 56 MB against the floor's 38 MB is their
  1/5 PSS share of the same 80 MB parent residue, inherited copy-on-write.
- Against HF, v2b `share()` now beats it on node PSS under forkserver (1,223 against 1,810), on anon above floor
  (+85 against +243) and on first batch (1.21 against 1.89 s, within noise of the floor). Under fork, it beats HF on node
  PSS (634 against 994) but not on anon above floor (+89 against +30).

### Where the remaining 80 MB is: glibc heap retention, not live data

`scripts/diag_share.py` was run once per mode in one process, with no DataLoader. MB from `smaps_rollup`, after
`gc.collect()` at each step:

| Step | Pss_Anon (with id normalization) | Pss_Anon (without) |
|---|---|---|
| start (packmem imported) | 11.0 | 10.9 |
| after `load_json` | 375.6 | 375.6 |
| after `set_column("id", ...)` | 377.0 | |
| after `share()` | **90.2** (Pss_Shmem 15.7) | **90.8** |
| after `ctypes.CDLL("libc.so.6").malloc_trim(0)` (returned 1) | **14.6** | **13.3** |

`share()` frees about 285 MB of the in-memory columns, but glibc keeps about 76 MB of the freed heap mapped. One
`malloc_trim(0)` returns it to the OS, leaving the parent at about 14 MB, the same as a process that only ran `open()`
(12 MB). The id normalization makes no difference. On Linux, calling `malloc_trim(0)` after dropping the buffers in
`share()` would likely close the gap to `open()`'s +6 / 245 MB. Allocating the large column buffers with mmap would do
the same. This was not measured in the DataLoader harness, because only the requested arms were rerun.

### v2b loads
`out3/runs.jsonl`: prep 32.2-36.9. DataLoader runs 21.1-27.7. Diagnostics 20.8-27.0. Available memory 96-109 GB, and
every run had rc=0.
Files: `out3/` (run JSON, `summary_v2b.md`, `setup.log`), `scripts/setup3.sh`, `scripts/run_all3.sh`,
`scripts/diag_share.py`. `run2.sh` now takes `PMB_OUT` from the environment and defaults to out2. Cleanup was done as
before: data, venv2b, pip cache, toolchain and target directory, source clone, wheel, saved .pkm and test copy deleted;
`cleanup_stale()` was run, and no `/dev/shm/packmem-*` files are left.
