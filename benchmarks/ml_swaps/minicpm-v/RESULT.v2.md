# packmem in MiniCPM-V fine-tuning: second pass (pickling, spawn workers)

This pass re-measures the change described in `RESULT.md` with the packmem wheel that can pickle a
`Table`. All runs were sequential, one process at a time; other work on the machine is described under
"Timed windows". Everything ran
locally. Nothing was pushed or posted.

- Wheel: `packmem-0.1.0-cp310-abi3-macosx_11_0_arm64.whl`, sha256 `a258403d...07dde9`, built from packmem
  `b421aec`+ (HEAD was `35d3f93` when copied; its `__init__.py` is identical to the source tree's). Installed with
  `pip install --force-reinstall --no-deps`, then imported once, untimed, with a tiny table.
- Machine: Apple M4 Pro (12 cores), 48 GB, macOS 26.6.2, Python 3.12.10, torch 2.15.0, torchvision 0.29.2,
  transformers 4.51.2.

## Patch

`packmem.v2.patch` is byte-identical to `packmem.patch` (+10 / -7 in `finetune/finetune.py` and
`finetune/dataset.py`). The v1 patch had no workarounds for missing Table features: it swaps
`json.load` for `packmem.load_json` and reads `self.raw_data[i]` once per item. The new APIs
(take/shuffle/extend/random.sample) have no call site here. Pickling is the only new feature this repository
uses, and it needs no code change: spawn workers now work with the unchanged patch.

## Method

`harness/v2/run_v2.py` is `harness/run.py` with the code moved under `if __name__ == "__main__"` and the stubs
moved to `harness/v2/mstubs.py`, so that spawn workers can import them. The stubs are the same: generated images
instead of COCO/GQA files and a word-level stub tokenizer. The workload is also the same: the real 665,298-record
LLaVA-1.5 mix converted to MiniCPM-V format (1.06 GB), `make_supervised_data_module` from the repository, and the
same 20,000 random indices (`torch.randperm`, seed 0), batch size 8, the repository's `data_collator`, `llm_type="qwen"`.

Memory is macOS `phys_footprint`. For the parent it is the lifetime peak; `/usr/bin/time -l` reports the same value.
For each worker, `harness/v2/wprobe.py` (a `worker_init_fn` thread) records the worker's own lifetime-peak footprint
every 0.2 s. Startup is measured from the worker process's creation time (psutil) to the moment its collate
function returned its first batch. "Parent + workers" is the parent's lifetime peak plus the sum of the four
workers' lifetime peaks, an upper bound on the concurrent total. The highest concurrent total sampled every 50
batches is up to 20% lower (macOS compresses the parent's idle pages, and the current footprint apparently counts
them at their compressed size, so it falls over time). Both are in the jsonl files. The first pass used a
`wprobe.py` with a race between its two writers (later fixed with a lock). It could only make a run fail, and
none did.

```sh
B=.../bench/OpenBMB__MiniCPM-V
$B/venv/bin/pip install --force-reinstall --no-deps packmem-0.1.0-cp310-abi3-macosx_11_0_arm64.whl
$B/harness/v2/bench_v2.sh      # (and bench_v2_rerun.sh for spawn, fork and pickle) waits for load <= 4 (max 10 min), then for cfg in workers=0, 4/spawn, 4/fork:
                               #   5 x {repo-orig, repo} interleaved, each a fresh
                               #   /usr/bin/time -l python run_v2.py --repo <arm> --data data/minicpm_665k.json \
                               #       --n 20000 --workers <0|4> --mp-context <fork|spawn>
                               # then run_v2.py --pickle once per arm
python3 ../../v2/summarize_jsonl.py $B/harness/v2/results_v2.jsonl
$B/venv/bin/python -I $B/harness/v2/verify_v2.py $B/data/minicpm_665k.json
```

### Timed windows and load averages

The first pass ran the three configurations from 15:27:13 to 15:58:58. The coordinator reported that another
agent ran CPU-heavy tests on this machine from about 15:47 to 16:06, which overlaps the end of the spawn
configuration, all of the fork configuration and the pickle timings. Those two configurations and the pickle
timings were run again in full from 16:49:54 to 17:09:42, after the 1-minute load had dropped to 3.96. The tables
below use the re-run for (b), (c) and (d), and the first pass for (a), which finished at 15:39:51. Memory figures
from the two passes agree within 0.5%. The first-pass timings for (b)-(d) are kept in `results_v2.jsonl` and
`pickle_repo*.out`, but they should not be used.

Load (1/5/15 min; `harness/v2/load.log`, `load_rerun.log`, plus each run's load in the jsonl files). The load did
not drop to 4 within the 10-minute wait before the first pass, so it started anyway. Desktop apps account for most of
the load (a browser at about 1.2 cores, WindowServer; during the re-run also two macOS indexing daemons,
spotlightknowledged and knowledgeconstructiond, at about 1 core each). The 4-worker runs add their own 5 processes.

| | start | end | used |
| --- | --- | --- | --- |
| (a) workers=0, 15:27:13-15:39:51 | 6.67 6.51 5.91 | 5.03 5.47 5.68 | yes |
| spawn, first pass, 15:39:51-15:52:11 | 5.03 5.47 5.68 | 8.58 7.77 6.68 | no (overlap) |
| fork, first pass, 15:52:11-15:58:22 | 8.58 7.77 6.68 | 9.96 9.14 7.73 | no (overlap) |
| (b) spawn, re-run, 16:49:54-17:04:10 | 3.96 5.30 5.31 | 5.74 7.28 6.89 | yes |
| (c) fork, re-run, 17:04:10-17:09:08 | 5.74 7.28 6.89 | 7.17 7.17 6.93 | yes |
| (d) pickle, re-run, 17:09:08-17:09:42 | 7.17 7.17 6.93 | 7.59 7.25 6.97 | yes |

## Results (medians of 5 fresh processes; MiB)

### (a) Main process only, num_workers=0

| | `json.load` list | packmem | |
| --- | --- | --- | --- |
| Peak footprint (`time -l`) | 5,266 | 803 | 6.6x lower |
| Peak RSS (`time -l`) | 5,327 | 945 | 5.6x lower |
| Footprint after the dataset is built | 5,187 | 725 | |
| Dataset build (`make_supervised_data_module`) | 3.5 s | 8.0 s | 2.3x slower |
| 20k samples through the DataLoader | 67.5 s | 67.6 s | same |
| Wall time | 73.4 s | 78.0 s | +4.5 s |

v1 (5 benchmarks running at once) had 5,266 / 805 MiB peak footprint and a 4.5 s / 9.1 s build. The memory
figures reproduce. Build times are lower now in both arms, and the ratio is unchanged.

### (b) 4 workers, `multiprocessing_context="spawn"` (new: did not work in v1)

| | `json.load` list | packmem | |
| --- | --- | --- | --- |
| Parent peak footprint | 9,661 | 2,281 | |
| Each worker's peak footprint | 3,461-3,472 | 924-937 | 3.7x lower |
| Sum of the 4 workers' peaks | 13,862 | 3,716 | |
| **Parent + 4 workers** | **23,514** | **5,997** | **3.9x lower** |
| Worker start to its first batch, by worker | 3.7 / 10.2 / 16.9 / 21.6 s | 1.3 / 2.8 / 4.3 / 5.8 s | |
| `iter(dl)` to first batch | 25.3 s | 6.0 s | 4.2x faster |
| `iter(dl)` to last batch (20k samples) | 50.3 s | 28.1 s | |
| Wall time, whole process | 76.0 s | 57.8 s | |

Each spawn worker receives a pickled copy of the dataset. The parent pickles it once per worker, and each worker
waits for the previous one to be sent, so startup is serial. With the list, each worker unpickles 671 MiB into
about 3.4 GiB of dicts. With packmem, each worker receives the 301 MiB packed table and holds about 606 MiB after
startup (interpreter, torch and the table). Its peak of about 930 MiB is reached while the bytes and the table both
exist. Per-worker values were stable; the range covers all 20 worker measurements. One run of the original arm
had a 253 s wall time (load 20.5). Its internal timings were normal (76 s), so the extra time was spent after the
measured interval, in process exit. The median is unaffected.

### (c) 4 workers, fork (as in v1)

| | `json.load` list | packmem | |
| --- | --- | --- | --- |
| Parent peak footprint | 5,219 | 756 | |
| Each worker's peak footprint | 532-546 | 176-192 | |
| Sum of the 4 workers' peaks | 2,151 | 730 | |
| **Parent + 4 workers** | **7,370** | **1,486** | **5.0x lower** |
| Worker start to first batch | 0.04-0.09 s | 0.03-0.07 s | |
| `iter(dl)` to last batch | 22.4 s | 22.3 s | same |
| Wall time | 27.8 s | 31.5 s | +3.7 s (build) |

v1 reported 6,839 vs 1,439 MiB for main + workers, using the parent's current footprint plus the workers' peaks.
This table uses the parent's lifetime peak. The worker sums match v1 (2,143 / 727).

### (d) Pickled size of the dataset object, `len(pickle.dumps(train_dataset))`

| | `json.load` list | packmem |
| --- | --- | --- |
| Pickled size | 704,043,890 B (671.4 MiB) | 315,825,848 B (301.2 MiB) |
| `Table.nbytes` | n/a | 301.2 MiB (same as the pickled size) |
| `pickle.dumps` (3 runs) | 3.41 / 3.27 / 3.33 s | 0.16 / 0.14 / 0.14 s |
| `pickle.loads` | 1.39 s | 0.03 s |
| Round trip equals the original, every record | yes | yes |

## Identical output

- `verify_v2.py`: all 665,298 records of `packmem.load_json` and of the same Table after `pickle.loads(pickle.dumps(t))`
  and after `Table.from_bytes(t.to_bytes())` are compared with `json.load`: `==`, key order, the types of `id` and
  `image`, and `json.dumps` of each record. 0 mismatches in each of the three.
- SHA-256 over every collated tensor (`input_ids`, `position_ids`, `labels`, `attention_mask`, every `pixel_values`
  tensor, `image_bound`, `tgt_sizes`) for the 20k samples: all 10 runs of workers=0 give `0803e050e386...`. All 40
  runs with 4 workers (both passes, spawn and fork, both arms) give `66c4dbcbe111...`. Both hashes are the same as in v1.
  (workers=0 differs from 4 workers because text-only records fall into the repository's random-retry path, which
  draws from a differently seeded RNG in the main process than in the workers.)

## Caveats, and where packmem is slower

- **Build is 2.3x slower** (3.5 s -> 8.0 s for 1.06 GB of JSON).
- **New packmem gap: pickling leaves the payload resident.** Each `Table.to_bytes()` call, and so each
  `pickle.dumps(table)`, leaves the process's footprint about one packed size higher after the bytes are freed. In a
  separate process (`fit-sweep/v2/tobytes_release.py`): 448 MiB after load, 1,980 MiB after 4 calls; still 1,980
  after 60 s idle; +1,271 MiB after 4 more calls. A later unrelated 1.5 GiB allocation did not reuse the memory
  either. `vmmap -summary` shows that live allocations are unchanged (`MALLOC_LARGE` 260 -> 283 MiB resident), while
  `MALLOC_LARGE (empty)` grows from 89 to 682 MiB and `MALLOC_REALLOC (empty)` to 190 MiB. These are freed malloc
  regions that stay dirty, not leaked objects. macOS reclaims them only under memory pressure, which matches what
  the Qwen3-VL epoch runs show. The likely cause is that `DynTable::to_bytes` grows its `Vec` by reallocation and then
  copies it into a `bytes` object (`python/src/lib.rs:979`). Pre-sizing the buffer, or writing straight into the
  bytes object, should avoid it. The parent pickles the dataset once per spawn worker, which is why its peak is
  2,281 MiB instead of about 800 MiB. Even so, it is 4.2x below the list version's 9,661 MiB, which also rises,
  by about 4.4 GiB, from the transient pickle buffers. Without `persistent_workers=True`, the DataLoader re-pickles
  the dataset every epoch.
- **Spawn startup is serial in both arms.** It is 4x shorter with packmem, but still 6.0 s before the first batch,
  against 0.13 s with fork.
- **Shutdown under spawn.** On this machine, every DataLoader with spawn workers spent about 20 s after the last
  batch shutting down (4 workers x the 5 s join timeout), in both arms. A DataLoader over a plain Python list does
  the same. This happens in torch/macOS, not in either version of the dataset, so the tables report time to the last
  batch. The wall times include it.
- **Loaded machine.** In the runs used here, the 1-minute load was 3.9-8.6 (12 cores), with one excursion to 20.5
  (see (b)). Apart from that run, wall times varied by up to 9% within a configuration. Memory figures varied by
  less than 1% across runs.
- The images and the tokenizer are stubs, as in v1. Per-item time is dominated by the stubbed image pipeline. The
  timings are not real training throughput.
- macOS `phys_footprint` stands in for Linux USS/PSS. Nothing was measured on Linux.

## Files

- `packmem.v2.patch` (identical to `packmem.patch`)
- `harness/v2/run_v2.py`, `mstubs.py`, `wprobe.py`, `bench_v2.sh`, `bench_v2_rerun.sh`, `verify_v2.py`
- `harness/v2/results_v2.jsonl` (first pass, 30 runs; only workers=0 is used), `results_v2_rerun.jsonl` (20 runs),
  `pickle_rerun_repo-orig.out`, `pickle_rerun_repo.out`, `load.log`, `load_rerun.log`
- Summarizer: `../../v2/summarize_jsonl.py` (`fit-sweep/v2/summarize_jsonl.py`)
