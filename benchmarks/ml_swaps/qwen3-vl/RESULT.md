# packmem in qwen-vl-finetune (QwenLM/Qwen3-VL)

Commit benchmarked: `96588727e44c78b25ba03ea03b8e12f7e64fd0da` (shallow clone, branch `packmem-annotations`).
Machine: Apple Silicon Mac, 48 GB, macOS, Python 3.13, torch 2.15.0, transformers 5.22.2, packmem 0.1.0 (local wheel).
Everything was run locally. Nothing was pushed or posted.

## What the code does

`qwenvl/data/data_processor.py:LazySupervisedDataset.__init__` reads every SFT annotation file
named in `--dataset_use` (`json.load` or `read_jsonl`), adds a `data_path` string to every record,
and keeps all records in `self.list_data_dict` for the whole run. `__getitem__` reads one record
and tokenizes it. Each torchrun rank holds its own copy, and the shipped scripts use
`--dataloader_num_workers 4`, so each rank's list is also inherited by 4 forked DataLoader workers.
Reading a record in a worker writes to Python refcounts (and the cyclic GC walks all the dicts), so
the workers copy the pages that hold the list, a little more with every batch.

## The change

`packmem.patch` (one file, +29 / -11). In non-packing mode:

- `json.load(...)` -> `packmem.load_json(path)`, `read_jsonl(path)` -> `packmem.load_jsonl(path)`.
- `ann["data_path"] = ...` on each dict -> the same assignment through `annotations.lazy()`,
  because rows returned by a `Table` are copies.
- `random.sample(annotations, k)` -> `random.sample(range(len(annotations)), k)` and index the
  table. `Table` is not a `collections.abc.Sequence`, so `random.sample` refuses it. The index form
  draws the same samples in the same order for the same RNG state (checked below).
- `list_data_dict += annotations` -> assign for the first dataset, `.extend()` for later ones.
  `Table` has no `+=`, and extending an empty table re-encodes every row (8.5 s for 665k), so the
  first dataset is taken as is.

With `--data_packing True` the annotation files hold lists of records (the output of
`tools/pack_data.py`), which packmem cannot store as rows (`load_json` raises ValueError). That path
is left on the original list code.

`__getitem__`, `lengths`, `modality_lengths` and `pre_calculated_length` are unchanged: they already
index the container and read keys, which works on a `Table`.

## Data

`llava_v1_5_mix665k.json` (the real LLaVA-1.5 mix, 1.03 GB, 665,298 records: 624,610 with an
image, 40,688 text-only), downloaded from the `liuhaotian/LLaVA-Instruct-150K` dataset repository.
For the multi-dataset case, a second file of the first 150,000 records was written out, and the run
used `llava665k%50,llava150k` (50 percent sampling of the first file, then the second file).

## Workload

`harness/bench.py` builds `LazySupervisedDataset` with the repo's `DataArguments` and a stub
processor: a deterministic tokenizer that turns text and the absolute image path into token ids,
with no model and no image decoding. It then

- `build`: computes `lengths` and `modality_lengths`, then calls `ds[i]` for 20,000 seeded random
  indices and collates them in batches of 4 with the repo's `DataCollatorForSupervisedDataset`;
- `loader`: does the same through `torch.utils.data.DataLoader(num_workers=4,
  multiprocessing_context="fork")`, as on Linux, and reads each worker's `phys_footprint` (private
  dirty plus compressed memory, from `proc_pid_rusage`) at 10, 50 and 90 percent of the batches;
- `verify`: hashes every row of `list_data_dict` as `json.dumps(row, sort_keys=True)`.

Image decoding, the vision tower and the model are left out on purpose. In real training they
dominate time and GPU memory. This benchmark only covers host RAM for annotation storage.

Commands (from `harness/`):

```
./run_all.sh build  llava665k 5 build665k
./run_all.sh loader llava665k 5 loader665k
./run_all.sh build  "llava665k%50,llava150k" 5 buildmix
N_SAMPLES=10000000 ./run_all.sh loader llava665k 1 epoch665k    # one full shuffled epoch
python summarize.py build665k loader665k buildmix epoch665k
```

`run_all.sh` alternates original and patched, one fresh `/usr/bin/time -l python -I bench.py ...`
process per run. The original tree is a `git worktree` of the same commit (`../orig`).

## Results

Median of 5 fresh processes unless noted. "Peak footprint" is `peak memory footprint` from
`/usr/bin/time -l`. On macOS this is more stable than max RSS, because the memory compressor can
lower RSS on a 5 GB process. Both are shown.

### One dataset, 665k records, main process only (`build`)

| | Original | packmem | Change |
| --- | --- | --- | --- |
| Peak footprint | 5,239 MB | 730 MB | 7.2x lower |
| Max RSS | 4,697 MB | 865 MB | 5.4x lower |
| Footprint after build | 5,204 MB | 627 MB | |
| Dataset build (load + data_path) | 3.6 s | 8.9 s | +5.3 s |
| `lengths` | 3.0 s | 6.1 s | 2x slower |
| `modality_lengths` | 2.4 s | 5.8 s | 2.4x slower |
| 20k `__getitem__` + collate | 5.7 s | 5.9 s | about the same |
| Wall time, whole process | 20.2 s | 28.5 s | +8.3 s |

### One dataset, 4 forked DataLoader workers, 20k samples (`loader`)

| | Original | packmem |
| --- | --- | --- |
| Main peak footprint | 5,240 MB | 727 MB |
| Each worker's footprint at 10 / 50 / 90 % of batches | 108 / 308 / 475 MB | 64 / 101 / 129 MB |
| Main + 4 workers footprint at 90 % | 7,131 MB | 1,213 MB |
| DataLoader time for 20k samples | 4.85 s | 2.91 s |
| Wall time, whole process | 20.4 s | 24.9 s |

### One full shuffled epoch through 4 workers (665,298 samples, 1 run each)

| | Original | packmem |
| --- | --- | --- |
| Each worker's footprint at 10 / 50 / 90 % | 1,185 / 2,419 / 2,783 MB | 255 / 372 / 393 MB |
| Main + 4 workers footprint at 90 % | 16,383 MB | 2,189 MB |
| DataLoader time | 90.8 s | 96.6 s |
| Wall time | 103.3 s | 117.9 s |

In the original, each worker's private memory keeps growing towards the size of the parent's list
as it touches more records. With packmem the records live in buffers that Python does not refcount,
so workers grow much less. Where their remaining growth (about 390 MB at the end) comes from was
not investigated. Per rank this is 16.4 GB against 2.2 GB, so an 8-GPU
node would hold roughly 131 GB against 18 GB of annotation-related host memory for this dataset.
That figure is extrapolated, not measured on Linux.

### Two datasets with 50 % sampling (`llava665k%50,llava150k`, 482,649 records)

| | Original | packmem |
| --- | --- | --- |
| Peak footprint | 5,639 MB | 2,202 MB |
| Footprint after build | 5,626 MB | 633 MB |
| Dataset build | 3.4 s | 17.9 s |
| Wall time | 17.4 s | 34.7 s |

The sampling path builds a temporary list of the sampled dicts before re-packing it, and the second
dataset is appended with `Table.extend`, which decodes and re-encodes every row. Both raise the peak
and the build time. The settled memory is the same as with one dataset.

## Identical output

- `verify` mode, sha256 over every row of `list_data_dict` (sorted keys), original against patched:
  identical for the JSON file (`7357e4d6...`), the JSONL file (same hash), the mixed and sampled
  config (`ec58b906...`, which confirms that index sampling selects the same records in the same
  order), and `--data_packing True` (unchanged path, `0a16b2d2...`).
- `lengths` and `modality_lengths`: same sha256 in every run of both variants (`348d788a...` for
  665k).
- Collated `input_ids`, `labels` and `position_ids` for the 20k fixed indices: same sha256 in all
  20 single-dataset runs (`3c98d761...`). The mixed config gives `93fd1a67...` for both variants.
  The full epoch gives `62f908d7...` for both.

## Caveats and where packmem did not help

- **Startup is slower.** `packmem.load_json` takes 8.4 s on this file against 2.7 s for `json.load`.
  These records are dominated by the nested `conversations` list, which packmem stores as one
  mixed column (296 MB of the 308 MB packed size). `lengths` and `modality_lengths` iterate over
  every row, which is 2 to 2.4 times slower. Together that is about 8 s more per rank, once per run.
- **Multiple datasets and sampling cost more.** `Table.extend(Table)` re-encodes rows (8.5 s per
  665k), and sampling goes through a list of dicts. The peak is 2.2 GB rather than 0.7 GB in that
  case.
- **`Table` cannot be pickled.** DataLoader workers started with `spawn` (the default on macOS and
  Windows, or if a user sets it) will fail. Linux training uses `fork` and works. On macOS this
  benchmark set `multiprocessing_context="fork"` explicitly. With the patch, training on macOS
  with workers and the default start method would fail; the original does not.
- **Key order of returned dicts differs** for text-only records: `id, conversations, model,
  data_path` instead of `id, model, conversations, data_path`. Nothing in the repo depends on key
  order. Dict equality is unaffected.
- **Packing mode is not covered.** Packed annotation files are lists of lists, which packmem
  does not store, so that path still uses lists.
- **New dependency.** packmem is alpha and not yet on PyPI. That alone may be a reason for
  maintainers to decline.
- **Not measured on Linux.** Footprint on macOS is a stand-in for Linux USS/PSS. The COW effect is
  the same mechanism, but the numbers will differ.
- **Harness quirk.** Two records in the real data have an empty assistant answer, and the stub
  tokenizer fails on them (a real processor would not). The repo's retry logic then falls back to the
  next index after three 1-second sleeps. This happens identically in both variants during the
  full epoch run and adds about 6 s to both.
- No repo tests cover this module, so no existing tests were run.
