# packmem 0.3.0 evidence: sub-column gates, compact, threads, agent datasets, GC (Linux)

**How to quote these numbers.** Every run was on a shared Linux server (AMD Ryzen 9 7950X3D, 124 GiB, Ubuntu 24.04,
Python 3.12.3, CPU torch 2.15.0). Each process ran in its own `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0`
at `nice -n 10`. Memory and size are the result. Timings are indicative, except gate-2's single-thread arm and gate-3,
which ran at a load average of 1-2. Per-run loads are in the `.meta`/`load*.log` files. Loader figures cover one process
building the dataset: annotations only, no model, no GPU. Upstreams: QwenLM/Qwen3-VL @9658872 and LLaVA-VL/LLaVA-NeXT
@bce12e47, both Apache-2.0. Patches: `packmem.v3.patch` and `llava.packmem.v2.patch`. The data is the real
`llava_v1_5_mix665k.json` (sha256 `ce959ce6…`). For LLaVA-NeXT, the synthetic 985k mix comes from `gen_data.py`
(macOS word list, sha256 `be41ad97…`).

## Sub-column gate vs PyPI 0.2.0 (rule: nothing slower or larger)

| | gate-1 e4508b1 (default threads off at that time) | gate-2 7b5dd99 `PACKMEM_THREADS=1` | gate-3 38d7bf2 `PACKMEM_THREADS=1` |
|---|---|---|---|
| Qwen3-VL VmHWM, 0.2.0 → candidate | 676 → 781 (+16%) | 678 → 730 (+7.6%) | 679 → 739 (+8.9%) |
| Qwen3-VL peak Pss_Anon (sampled) | – | – | **542 → 495 (−8.5%)** |
| Qwen3-VL Pss_Anon after build | 542 → 534 | 542 → 505 | 542 → 495 |
| LLaVA-NeXT VmHWM | 1,601 → 1,722 (+8%) | 1,603 → 1,666 (+3.9%) | 1,604 → 1,666 (+3.9%) |
| LLaVA-NeXT peak Pss_Anon | – | – | 1,187 → 1,249 (+5.2%) |
| LLaVA-NeXT Pss_Anon after build | 1,135 → 1,066 | 1,121 → 1,021 | 1,120 → 1,023 |
| Qwen3-VL build / LLaVA-NeXT construction | 9.0 → 10.8 s / 33 → 45 s (load 10-43) | 6.2 → 6.4 / 21.7 → 23.3 s | 6.2 → 6.5 / 21.7 → 23.8 s |

- **gate-2 note:** its first "threads=1" arm (`S2_*`, arm `repo@candt`) is invalid. Ubuntu's
  `/usr/lib/python3.12/sitecustomize.py` shadowed the venv's, so that arm ran threaded. The valid single-thread arm is
  `S3_*_t1`, with the variable set in the environment.
- **VmHWM vs anonymous memory:** VmHWM includes file-backed pages. A standalone `load_json` single-thread split
  (`threads_split_f47f944/gate3_split.jsonl`) gives a peak RssAnon of 359 MB on 0.2.0 vs 309 MB on the candidate.
- **Status:** on Qwen the heap peak is lower and only VmHWM is higher. On LLaVA-NeXT the heap peak is about 5% higher.
  Settled memory is 9% lower in every gate run.

- **Later: gate-4 on a456190 passes on memory.** The remaining peak was a full pass over the rows, not the load
  (string values of nested records were being interned). With that fixed, peak anonymous memory sampled every 2 ms
  is 567 → 532 MB on Qwen3-VL and 1,446 → 1,346 MB on LLaVA-NeXT. One-thread construction is still 4-8% slower.
  See `README_gate4.md`, `gate4_a456190/` and `llava_construction_a456190/`.

## Default threads (load_json threaded), 38d7bf2

| | 0.2.0 | candidate |
|---|---|---|
| Qwen3-VL build | 6.2 s | 1.5 s |
| Qwen3-VL VmHWM / peak Pss_Anon | 678 / 542 MB | 997 / 503 MB |
| LLaVA-NeXT construction | 21.6 s | 15.7 s |
| LLaVA-NeXT VmHWM / peak Pss_Anon | 1,601 / 1,107 MB | 1,908 / 1,123 MB |

Threads split on f47f944 (`threads_split_f47f944/threads.jsonl`, sampler at 20 ms). For llava665k, threads=1 vs default:
load 6.4 vs 1.5 s; peak RssAnon 320 vs 323 MB; settled Pss_Anon 320 vs 323 MB; VmHWM 454 vs 784 MB. The difference is
transient pages of the mapped input file.

## hint="compact"

First build 9f8da2b (`compact_first_9f8da2b/`): 296 → 214 MB at 26 µs per random row.
Sweep on 7b5dd99 (`compact_sweep_7b5dd99/`, level 3, median of 2):

| block / dictionary | nbytes | build | random row | full pass | per-worker Pss_Anon (open, 4 spawn) |
|---|---|---|---|---|---|
| default hint | 296.2 MB | 1.5 s | 4.7 µs | 2.9 s | 13.6 MB |
| 512 / 256 KB | 209.6 | 4.0 | 8.2 | 4.1 | 27.4 |
| **1024 / 256 KB** (chosen default) | **200.7** | 3.5 | 10.9 | 4.8 | 25.3 |
| 2048 / 256 KB | 193.5 | 3.3 | 12.9 | 5.5 | 22.1 |
| 512 / 1 MB | 227.0 | 5.1 | 6.8 | 3.6 | 35.9 |
| 1024 / 1 MB | 221.4 | 4.6 | 8.0 | 4.3 | 34.5 |
| 2048 / 1 MB | 200.8 | 4.5 | 11.2 | 5.1 | 41.5 |
| 1024 / 256 KB, level 9 | 184.8 | 5.7 | 11.6 | 5.0 | – |

All 665,298 rows equal `json.load` in both modes, and `to_json()` is identical to the default.

## Agent, tool-call, computer-use and browser-use datasets; GC (`agent_suite/RESULT_draft.md`)

Main 4629330 and PyPI 0.2.0; 8 public datasets; 464 runs.

- **Faithfulness:** packmem changed 0 records in every build. HF `datasets` 5.2.0 failed to load hermes_fc,
  None-filled keys in 2,331 of 5,000 agentnet records, and coerced 306 of 7,735 gui_odyssey records.
- **Size with compact:** swe_rebench 1,130 → 193 MB; mind2web 565 → 62 MB.
- **GC:** at 16k in-flight episodes the worst gen-2 pause drops from 2.37 s to 0.10 s, but total GC time is about equal,
  and reading an episode back is about 77x slower.

## Diagnostics

- `parquet_share/pqshare.jsonl`: after `share()` the parent's 1.9 GB drops to 171 MB with
  `pyarrow.default_memory_pool().release_unused()`, so it is pyarrow's (mimalloc) pool, not packmem. Addressed in 52ece92.
- `nested_queries/`: `describe()` of the nested columns, plus query timings before and after 7d18521 (sub-column field
  reads). Example: swe_smith role_counts 1,930 → 26 ms, matching a Python loop over the list.
