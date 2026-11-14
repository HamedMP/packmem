# Sub-column gate (e4508b1) and `hint="compact"` (9f8da2b) vs PyPI 0.2.0, Linux

**How to quote these numbers.** Memory figures (Pss_Anon, VmHWM/ru_maxrss, nbytes, file sizes) are the
result. Timings are indicative only: the server is shared with CI and its 1-minute load was 10-43 during these
runs (per-run loads in `load.log` and each `*.meta`). Loader figures are one process building the dataset,
annotations only, no model, no GPU.

- Host: a shared Linux server (AMD Ryzen 9 7950X3D, 124 GiB, Ubuntu 24.04, Python 3.12.3, CPU torch 2.15.0).
  Every run in its own `systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0`, `nice -n 10`.
- Wheels: candidate e4508b1 sha256 `71c6b622…6d4b`; compact build 9f8da2b sha256 `2f1b172b…e5a`;
  PyPI 0.2.0 manylinux2014 sha256 `09c5ba04…14c7`.
- Data: real `llava_v1_5_mix665k.json` (sha256 `ce959ce6…af6cf8`, 665,298 records) for Qwen3-VL
  qwen-vl-finetune @9658872 + `packmem.v3.patch`; LLaVA-NeXT @bce12e47 + `packmem.v2.patch` on the synthetic
  985k mix from `gen_data.py` (word list copied from macOS `/usr/share/dict/words`, sha256 `be41ad97…`, so the data
  matches the earlier macOS runs).

## Gate: candidate e4508b1 vs 0.2.0 at defaults (median of 5)

| | list | 0.2.0 | candidate | candidate vs 0.2.0 |
|---|---|---|---|---|
| Qwen3-VL build | 9.0 s | 9.0 s | 10.8 s | +20% (timing, noisy) |
| Qwen3-VL peak (VmHWM) | 4,169 MB | 676 MB | 781 MB | **+105 MB (+16%)** |
| Qwen3-VL Pss_Anon after build | 3,059 MB | 542 MB | 534 MB | −1% |
| Qwen3-VL `Table.nbytes` | – | 308.3 MB | 296.2 MB | −3.9% |
| LLaVA-NeXT construction | 16.9 s | 33.1 s | 45.1 s | +36% (timing, noisy) |
| LLaVA-NeXT peak | 4,246 MB | 1,601 MB | 1,722 MB | **+121 MB (+8%)** |
| LLaVA-NeXT Pss_Anon after build | 4,073 MB | 1,135 MB | 1,066 MB | −6% |

Single-run memory breakdown (`subcol/mem_*.json`): Qwen peak 675 → 769 MB, malloc in-use 408 → 396 MB, nbytes
308 → 296 MB; LLaVA peak 1,600 → 1,748 MB, in-use 838 → 781 MB, nbytes 716 → 658 MB. So the live table is
smaller and settled memory is equal or lower, but **the peak during load is higher** on glibc as well, i.e. the
extra memory is a real transient working set of the shredding step, not only macOS allocator retention.

**Verdict:** fails the "nothing larger than 0.2.0" rule on peak memory (+8 to +16%). Settled memory and size pass.
Build time is slower in this run, but the load (10-43) is too high to call it.

## What sub-columns buy (Qwen3-VL, `subcol/qwen_*.json`)

| | list | 0.2.0 | candidate |
|---|---|---|---|
| `lengths` (Python loop) | 2.55 s | 6.38 s | 6.63 s |
| `lengths` via column ops | – | – | **0.665 s** (values equal the loop, `colops_lengths_equal_loop: true`) |
| 100k random rows to dict | 0.018 s | 1.37 s | 1.48 s |
| Full pass as dicts | 0.036 s | 6.45 s | **3.74 s** |

- Column ops are 3.8x faster than the plain-list loop and ~10x faster than packmem's own loop; the values equal
  the list's exactly (sha `348d788a…`), including Python `str.split()` whitespace.
- Decoded rows are identical in all arms (rows sha `42eb499c…`). `to_json()` bytes differ from 0.2.0 as expected
  (canonical nested form), and decode equal.
- `describe()`: `conversations` is stored as `list<from: str:dict(2)/1bit, value: …>` in every chunk (39 chunk
  variants of the value encoding; no "mixed" fallback seen).

## `hint="compact"` (9f8da2b) on the real 665k mix (`compact/`, median of 3)

| | default | compact (level 3) | compact level 9 (1 run) |
|---|---|---|---|
| `Table.nbytes` | 296.2 MB | **214.5 MB (−28%)** | **188.4 MB (−36%)** |
| saved file | 296.2 MB | 214.5 MB | 188.4 MB |
| build | 9.2 s | 10.8 s | 19.5 s |
| random row to dict | 7.1 µs | 26.4 µs (3.7x slower) | 31.1 µs |
| full pass | 4.4 s | 12.7 s (2.9x slower) | 14.7 s |
| `lengths` column ops | 0.77 s | 1.32 s | – |
| Pss_Anon after build / after release | 354 / 295 MB | 270 / 219 MB | – |
| per-worker Pss_Anon with `open()` (4 spawn workers, after 5k random rows) | 13.6 MB | 19.4 MB | – |

- Correctness: all 665,298 rows equal `json.load` in both modes; `to_json()` is identical between default and
  compact.
- `+zstd` applies to `conversations.value` in most chunks; `id` and `image` stay FSST/dictionary.
- Against the feasibility target (160-185 MB): level 3 reaches 214 MB and level 9 reaches 188 MB. Per-row zstd
  with a 1 MB trained dictionary reached 172 MB (L3) / 148 MB (L9) in the feasibility run, so the gap is likely the
  64 KB dictionary and 2 KB blocks.
- Random access costs ~19 µs more per row than the default, far more than the ~2.5 µs decode measured in the
  feasibility run. Each random read probably decodes a whole block, and possibly builds a decompression context or
  dictionary per block.
