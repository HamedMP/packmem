# packmem in LLaVA-NeXT `LazySupervisedDataset`: second pass (pickling, spawn workers, native take/extend)

This pass re-measures `RESULT.md` with the packmem wheel that can pickle a `Table` and adds `take` and a native
`extend(Table)`. All runs were sequential, with no other benchmark of mine running at the same time. Everything ran
locally. Nothing was pushed or posted.

- Upstream commit `bce12e479bc4dfee2b9c50c88137b01ff51bd483`, as in v1. `repo-orig/` is the unpatched worktree;
  `repo/` has the v2 patch applied.
- Wheel: `packmem-0.1.0-cp310-abi3-macosx_11_0_arm64.whl`, sha256 `a258403d...07dde9`, packmem `b421aec`+.
  Installed with `pip install --force-reinstall --no-deps`, then imported once, untimed.
- Machine: Apple M4 Pro (12 cores), 48 GB, macOS 26.6.2, Python 3.12.10, torch 2.15.0, transformers 4.49.0.

## Patch changes (v1 -> v2)

`packmem.v2.patch`: `llava/train/train.py`, +11 / -13 (same as v1). One line changed. For `random:N` sampling,
v1 shuffled a list of indices and rebuilt a table from a generator of rows,
`packmem.Table(cur_data_dict[i] for i in order[:n])`. v2 takes the rows natively:

```python
order = list(range(len(cur_data_dict)))
random.shuffle(order)
cur_data_dict = cur_data_dict.take(order[:sampling_number])
```

The RNG is consumed exactly as `random.shuffle(cur_data_dict)` consumes it, so the same records are picked in the
same order (hashes below). On `si_mix.json` (300k rows, 150k picked) this takes 0.69 s, against 1.62 s for the v1
generator rebuild and 1.93 s for `cur_data_dict.shuffle()` followed by `del cur_data_dict[n:]`.

Kept as in v1:
- `del cur_data_dict[n:]` / `del cur_data_dict[:-n]` for `first:` / `end:`. Since this wheel, `del` is already one
  native rebuild. It costs the same as `take(range(...))` (0.76 vs 0.78 s for 200k of 300k rows) and keeps the
  slice semantics exactly (an N larger than the file).
- `self.list_data_dict.extend(cur_data_dict)` is the original line. With this wheel it runs natively instead of
  decoding and re-encoding each row. That is the main reason dataset construction fell from 33.2 s (v1) to 23.1 s.
  Assigning the first table instead of extending an empty one would save a further ~1-3 s per file, but needs a
  larger diff; not done.

`llava/train/train_dpo.py` has a copy of the loader and is still untouched.

## Method

The data is the same synthetic 985,000-record mix as v1 (`data/mix.yaml`: all of a 665k LLaVA-1.5-like file,
`end:200000` of a 300k single-image file, `first:80%` of 150k ShareGPT text records).

v1 measured lookups with `bench.py` and forked workers with `workers.py`, outside a DataLoader. v2 adds
`harness/v2/run_v2.py`, which goes through a real `torch.utils.data.DataLoader`:

- `harness/v2/llava_ds.py` subclasses the repository's `LazySupervisedDataset` only to stub image decoding
  (`process_image` returns a tiny tensor derived from the path), and replaces the module-level `preprocess` with a
  word-hash tokenizer. Everything else in `__getitem__`/`_get_item` is the repository's code: the
  `list_data_dict[i]` lookups, the `deepcopy` of the conversations, `preprocess_multimodal` (with
  `is_multimodal=True`) and the retry logic. Both live in an importable module, so spawn workers use them too.
- The script builds the dataset from `mix.yaml` and computes `lengths` and `modality_lengths` (as the
  length-grouped sampler does). It then reads **20,000 seeded random indices** (`random.Random(1).sample`; v1
  used 10,000 direct lookups) with batch size 4 through the repository's `DataCollatorForSupervisedDataset`,
  and hashes every collated tensor.
- Per-worker memory and startup come from `harness/v2/wprobe.py`, as for the other two repositories. MiB below.
  "Parent + workers" is the parent's lifetime peak plus each worker's lifetime peak.

```sh
B=.../bench/LLaVA-VL__LLaVA-NeXT
$B/venv/bin/pip install --force-reinstall --no-deps packmem-0.1.0-cp310-abi3-macosx_11_0_arm64.whl
$B/harness/v2/bench_v2.sh    # waits for load <= 4 (max 10 min); for cfg in workers=0, 4/spawn, 4/fork:
                             #   5 x {repo-orig, repo} interleaved, fresh
                             #   /usr/bin/time -l python -I run_v2.py <arm> data/mix.yaml --workers <0|4> --mp-context <ctx>
                             # then run_v2.py --pickle once per arm
python3 ../../v2/summarize_jsonl.py $B/harness/v2/results_v2.jsonl
# equivalence, untimed, with the v1 script:
python harness/bench.py <repo-orig|repo> <mix.yaml | mix_random.yaml | {si_mix,llava_v1_5_mix665k}.json | si_mix.json> out.json --hash
```

### Timed window and load

A first attempt at 17:19:46 was aborted after 15 s, because another project's `pnpm` build and `vitest` run had
pushed the load to 10.5. No result from it is used (`load_aborted.log`). The run used here went from **17:29:56 to
17:53:48** and started once those processes had exited and the load had fallen to 3.93. A packmem wasm `cargo
build` from another session ran at about 17:35:50-17:37:15, during the first spawn run of each arm. That first
original-arm run is the slowest of its five (78.2 s against 72.4-74.3 s), and the medians are not affected.
`foreign.log` records non-benchmark processes above 40% CPU, sampled every 5 s.

| | start | end |
| --- | --- | --- |
| workers=0 (17:29:56-17:35:47) | 3.93 6.17 7.03 | 9.03 7.52 7.32 |
| 4 workers, spawn (17:35:47-17:47:44) | 9.03 7.52 7.32 | 4.07 5.17 6.08 |
| 4 workers, fork (17:47:44-17:52:54) | 4.07 5.17 6.08 | 2.50 4.10 5.35 |
| pickle (17:52:54-17:53:48) | 2.50 4.10 5.35 | 1.96 3.67 5.11 |

## Results (985,000 records; medians of 5 fresh processes; MiB)

### (a) Main process only, num_workers=0

| | list of dicts | packmem | |
| --- | --- | --- | --- |
| Peak footprint (`time -l`) | 5,188 | 1,818 | 2.9x lower |
| Peak RSS (`time -l`) | 5,239 | 1,992 | 2.6x lower |
| Footprint after the dataset is built | 3,889 | 1,551 | 2.5x lower |
| `LazySupervisedDataset(...)` construction | 5.3 s | 23.1 s | **4.4x slower** |
| `lengths` / `modality_lengths` | 5.3 / 5.4 s | 9.4 / 8.8 s | 1.7x slower |
| 20k samples through the DataLoader | 1.57 s | 1.90 s | +21% |
| Wall time | 23.8 s | 45.7 s | 1.9x |

v1: peak RSS 4,991 / 1,928 MiB, footprint after build 3,888 / 1,564 MiB, construction 7.9 / 33.2 s. The memory
reproduces. Construction is 10 s faster with the native `extend`, but it is still 4.4x slower than `json.load`.

### (b) 4 workers, spawn (new: did not work in v1)

| | list of dicts | packmem | |
| --- | --- | --- | --- |
| Parent peak footprint | 11,570 | 4,197 | |
| Each worker's peak | 4,252-4,258 | 1,597-1,601 | 2.7x lower |
| Sum of the 4 workers' peaks | 17,015 | 6,391 | |
| **Parent + 4 workers** | **28,584** | **10,588** | **2.7x lower** |
| Worker start to first batch, by worker | 3.8 / 10.2 / 17.6 / 23.9 s | 1.5 / 3.3 / 5.1 / 6.9 s | |
| `iter(dl)` to first batch | 28.4 s | 7.3 s | 3.9x faster |
| `iter(dl)` to last batch | 35.0 s | 8.8 s | |
| Wall time (includes ~20 s worker shutdown) | 73.4 s | 69.2 s | |

Each packmem worker ends at about the same footprint as its peak, about 1.6 GiB, against a 683 MiB table plus
about 230 MiB of interpreter and torch. The rest is the freed pickle payload, which macOS's allocator keeps
resident (see caveats). In this run, a worker's whole share of the 20k samples takes about 1.5 s, which is
probably too short for the OS to reclaim it. In the longer MiniCPM-V and Qwen3-VL runs, the same memory came
back down to roughly the table plus the baseline.

### (c) 4 workers, fork (v1 measured forked workers outside a DataLoader)

| | list of dicts | packmem | |
| --- | --- | --- | --- |
| Parent peak footprint | 5,187 | 1,822 | |
| Each worker's peak | 465-519 | 134-146 | |
| Sum of the 4 workers' peaks | 2,024 | 552 | |
| **Parent + 4 workers** | **7,212** | **2,374** | **3.0x lower** |
| Worker start to first batch | 0.02-0.07 s | 0.02-0.03 s | |
| `iter(dl)` to last batch | 1.54 s | 1.43 s | same |
| Wall time | 20.2 s | 41.4 s | 2x (construction) |

These 20k samples touch 2% of the records. v1's `workers.py` read every record in the workers and found 2,100 vs
693 MiB copied per worker. A full epoch would grow the list-of-dicts workers towards that.

### (d) Pickled size of the dataset, `len(pickle.dumps(dataset))`

| | list of dicts | packmem |
| --- | --- | --- |
| Pickled size | 1,438,835,634 B (1,372 MiB) | 715,840,588 B (682.7 MiB) |
| `Table.nbytes` | n/a | 682.7 MiB (same) |
| `pickle.dumps` (3 runs) | 3.60 / 3.52 / 3.67 s | 0.42 / 0.39 / 0.45 s |
| `pickle.loads` | 1.66 s | 0.06 s |
| Round trip equals the original, every row | yes | yes |

The pickled list is only 1.9x larger than the table, against 2.2-2.3x for the other two repositories. 97% of the
packed bytes are the `conversations` text, which pickle also stores compactly.

## Identical output

v1's `harness/bench.py --hash`, one fresh process per version and configuration, `random.seed(0)`
(`harness/v2/verify/check_*.json`):

| data_path | records | lengths | modality_lengths | 10k sampled (id, conversations) | all rows, sorted keys | all rows, key order kept |
| --- | --- | --- | --- | --- | --- | --- |
| `mix.yaml` (all / end: / first:%) | 985,000 | identical | identical | identical | identical (`b98466ab5d0a`) | differs, as in v1 |
| `mix_random.yaml` (random:% and random:N, the `take` path) | 170,000 | identical | identical | identical | identical (`e78cd672df0b`) | differs, as in v1 |
| `{si_mix,llava_v1_5_mix665k}.json` | 965,000 | identical | identical | identical | identical | differs, as in v1 |
| `si_mix.json` | 300,000 | identical | identical | identical | identical | identical |

Every v2 hash, including the key-order ones, equals the corresponding v1 patched hash. The key-order difference is
v1's: ShareGPT rows come back as `id, conversations, model`. The `take`-based `random:` sampling selects the same
records in the same order as `random.shuffle` on the list.

DataLoader output: SHA-256 over every collated tensor (`input_ids`, `labels`, `attention_mask`, every image
tensor, `image_sizes`, `modalities`) for the 20k samples is `392700325fba...` in all 30 runs (workers=0, spawn and
fork; both arms). `lengths` + `modality_lengths` hash to `e45b09149f...` in all 30 runs. In `--pickle` mode, every row
of the unpickled dataset equals the original, in both arms.

## Caveats, and where packmem is slower

- **Construction is 4.4x slower** (5.3 s -> 23.1 s per rank at 985k records; roughly 75 s at the full 3.2M-record
  OneVision mix, by extrapolation). `load_json` on these nested records is the main cost. `lengths` and
  `modality_lengths` are each 1.7x slower. With fork, the whole script takes twice as long (20 s -> 41 s), all of it
  before the first batch.
- **The pickled payload stays resident.** Each `Table.to_bytes()` / `pickle.dumps(table)` leaves about one packed
  size of freed memory resident in the macOS malloc zone (`vmmap`: `MALLOC_LARGE (empty)` and `MALLOC_REALLOC
  (empty)` grow, while live allocations do not). The parent here pickles a 683 MiB table four times, so its peak is
  4,197 MiB instead of about 1,800 MiB. Spawn workers likewise keep the received bytes for a while. The memory is
  reclaimed only under memory pressure. The likely cause is that `to_bytes` grows its output `Vec` by reallocation
  and then copies it into a `bytes` object; writing into a pre-sized buffer would avoid both. This was not
  checked on Linux.
- **Spawn startup is serial in both arms.** With packmem the first batch arrives after 7.3 s, against 28 s with the
  list and 0.1 s with fork.
- **About 20 s of DataLoader shutdown under spawn** in both arms (torch's 5 s join timeout x 4 workers on this
  machine; a plain-list DataLoader does the same). The tables report time to the last batch.
- **Per-sample lookups are slower** (20k samples 1.57 s -> 1.90 s, with stubbed images and tokenizer). This is
  negligible beside real image decoding.
- **Synthetic data**, as in v1: text is Zipf-sampled words, so compression on real captions may differ.
- **Key order and in-place mutation**, as in v1: ShareGPT rows come back as `id, conversations, model`, and the
  video branch's in-place edit of `conversations` no longer persists between reads.
- macOS `phys_footprint` stands in for Linux USS/PSS. Nothing was measured on Linux.

## Files

- `packmem.v2.patch`; `packmem.patch` unchanged.
- `harness/v2/llava_ds.py`, `run_v2.py`, `wprobe.py`, `bench_v2.sh`
- `harness/v2/results_v2.jsonl` (30 runs), `pickle_repo-orig.out`, `pickle_repo.out`, `load.log`, `foreign.log`,
  `load_aborted.log`, `verify/check_*.json`
