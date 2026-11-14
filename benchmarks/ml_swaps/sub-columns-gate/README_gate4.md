# Sub-column gate 4: a456190 (no string interning in nested records) vs PyPI 0.2.0

**How to quote these numbers.** Same server and method as gates 1-3 (AMD Ryzen 9 7950X3D, 124 GiB, Ubuntu 24.04, Python
3.12.3). Each process ran in its own `systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0` at `nice -n 10`, with
`PACKMEM_THREADS=1` set in the environment for both arms. The load average was 1-2 for the gate-4 runs and 0.1-1.1 for the
LLaVA-NeXT construction runs (per-run load averages are in `load.log` and the `.meta` files). Memory comes from an external
2 ms `/proc/<pid>/status` sampler (`harness/peaksample.py`), not from VmHWM. VmHWM includes file-backed pages and,
as gate-3 showed, a 200 ms sampler misses short anonymous peaks. Runs were interleaved; even runs put 0.2.0 first.
Values are medians of 5 runs. Phase values are medians of 3. Candidate wheel: a45619009789 (wheel sha256 in `load.log`).
Data and upstream commits are the same as in the 0.3.0 bundle README.

## Result: memory passes

| | 0.2.0 | a456190 | change |
|---|---|---|---|
| Qwen3-VL build, peak RssAnon (2 ms) | 567.0 MB | 531.8 MB | **−6.2%** |
| Qwen3-VL build, peak VmRSS | 648.5 | 613.6 | −5.4% |
| Qwen3-VL build, peak RssFile | 90.9 | 91.2 | = |
| Qwen3-VL RSS after build | 627.2 | 577.2 | −8.0% |
| LLaVA-NeXT construction, peak RssAnon (2 ms) | 1,445.9 MB | 1,345.6 MB | **−6.9%** |
| LLaVA-NeXT construction, peak VmRSS | 1,531.9 | 1,431.8 | −6.5% |
| LLaVA-NeXT Pss_Anon settled (after release) | 944.7 | 886.2 | −6.2% |

Output is identical in both arms. Qwen3-VL `batches_sha256` is `3c98d761…` and `lengths_sha256` is `348d788a…`
(5/5 runs each). LLaVA-NeXT dataset `sha256` is `39270032…` and `lengths_sha` is `e45b0914…` (5/5 each).

## Time: construction is slower, the length passes are faster

| | 0.2.0 | a456190 | change |
|---|---|---|---|
| Qwen3-VL build (`load_json`) | 6.24 s | 6.49 s | +4.0% |
| Qwen3-VL `lengths` / `modality_lengths` | 6.33 / 6.40 s | 4.28 / 4.25 s | −32% / −34% |
| Qwen3-VL random `__getitem__` x20k | 8.78 s | 8.67 s | = |
| LLaVA-NeXT construction (`load_s`) | 21.35 s | 23.07 s | +8.0% |
| LLaVA-NeXT `lengths` / `modality_lengths` | 10.77 / 10.88 s | 8.03 / 8.12 s | −25% / −25% |
| LLaVA-NeXT full iteration | 4.16 s | 3.86 s | −7% |

LLaVA-NeXT construction runs spread by ≤0.26 s per arm (0.2.0: 21.32-21.37 s; candidate: 22.99-23.25 s). A trainer
that computes the lengths for its length-grouped sampler (both upstreams do) finishes dataset setup sooner on the
candidate: Qwen3-VL 19.0 → 15.0 s, and LLaVA-NeXT 43.0 → 39.2 s.

## Where the gate-3 regression went (Qwen3-VL phases, `phase_qwen_*.json`)

| phase | 0.2.0 peak / Δ / end | a456190 peak / Δ / end |
|---|---|---|
| `load_json` | 407.9 / 398.4 / 357.4 | 370.7 / 361.1 / 311.6 |
| `set_column("data_path")` | 357.4 / 0 / 357.4 | 306.2 / 0 / 306.2 |
| `lengths` (row iteration) | 395.2 / 37.9 / 395.1 | 338.4 / 32.2 / 338.4 |
| `modality_lengths` | 403.2 / 8.1 / 403.2 | 348.4 / 10.0 / 348.4 |
| random `__getitem__` x20k | 403.2 / 0 / 403.2 | 348.4 / 0 / 348.4 |

On the gate-3 commit, the full row iteration retained an extra +135 MB. The cause was `PyString::intern` on the
string values of nested records: interned strings are never freed in Python 3.12. a456190 stops interning those values,
and the iteration delta is now below 0.2.0's.

## Files

- `gate4_a456190/qwen_{020,cand}_N.peak.json` and `llava_{020,cand}_N.peak.json`: sampler peaks, plus the largest
  mappings at the RSS peak.
- `gate4_a456190/qwen_{020,cand}_N.json`: Qwen3-VL bench output (timings, hashes).
- `gate4_a456190/phase_qwen_{020,cand}_N.json`: per-phase RssAnon at 2 ms.
- `llava_construction_a456190/`: `run_linux.sh llava-build 5 S5_llava_t1 repo@cand repo@020` (the script is in the
  0.3.0 bundle) with `PACKMEM_THREADS=1`; the `.json` is the result and the `.meta` holds rc, wall and load.
- `harness/`: `gate4.sh` (driver), `peaksample.py`, `phasesample.py` and `phases.py`.
- `load.log`: the candidate's commit and wheel sha256, plus per-run load averages.

Paths are rewritten to `$WORK` (the server work directory).
