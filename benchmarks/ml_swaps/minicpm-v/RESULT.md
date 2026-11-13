# packmem in MiniCPM-V fine-tuning: benchmark notes

## What the code does

`finetune/finetune.py` loads the whole training JSON with `json.load` and hands the resulting
list of dicts to `SupervisedDataset` (`finetune/dataset.py`), which keeps it as `self.raw_data`
for the whole run. `__getitem__(i)` reads `raw_data[i]["image"]` and `raw_data[i]["conversations"]`,
opens the image(s) and tokenizes the conversation. Every torchrun rank holds its own copy, and
with `--dataloader_num_workers N` every forked worker gradually copies the pages it touches
(reference counting writes to the shared objects).

## The change

Branch `packmem-raw-data` in the clone, 10 lines added, 7 removed (`packmem.patch`):

- `finetune/finetune.py`: `json.load(open(path, "r"))` becomes `packmem.load_json(path)` for the
  train and eval files, plus `import packmem`.
- `finetune/dataset.py`: `__getitem__` reads `self.raw_data[i]` once into `sample` instead of
  three or four times. With a list this is free either way; with packmem each index decodes the
  row, so reading it once avoids repeated work. It does not change behaviour for a list.

Nothing else changes: `raw_data[i]` still returns a plain dict with the same keys, key order and
value types (str or dict `image`, int or str `id`, records without `image`).

## Data

The real LLaVA-1.5 mix used by many MiniCPM-V fine-tuning recipes,
`llava_v1_5_mix665k.json` (1.03 GB, 665,298 records) from
`liuhaotian/LLaVA-Instruct-150K`, converted to MiniCPM-V's format by `harness/convert.py`:
`from/value` -> `role/content`, `human/gpt` -> `user/assistant`. To exercise the multi-image
code path, 2% of image records (chosen by crc32 of the id) use the dict form
`{"<image_00>": path}`. Result: 612,264 records with a string `image`, 12,346 with a dict,
40,688 text-only records with no `image` key. Written with `indent=2` and ASCII escapes like the
source file (1.06 GB).

## Workload

`harness/run.py` imports the repository's own `finetune.py` and calls
`make_supervised_data_module` (so the patched load line is what runs), then reads 20,000
random indices (fixed seed) through a `torch.utils.data.DataLoader` with the repository's
`data_collator`, batch size 8, `llm_type="qwen"`, `batch_vision=True` and the default slice
config (`max_slice_nums=9`, `scale_resolution=448`).

Stubs, identical for both arms:

- `Image.open` returns a small generated image whose size and colour derive from the path
  (the COCO/GQA/OCR-VQA/TextVQA/VG images are not on this machine).
- A deterministic word-level tokenizer that exposes the attributes `dataset.py` reads
  (`apply_chat_template`, `convert_tokens_to_ids`, `im_start`, `slice_start`, ...). No model is loaded.

The `minicpm` llm_type path could not be used: on the current main, `conversation_to_ids`
calls `.shape` on the Python list returned by `conversation_to_ids_minicpm` and raises
`AttributeError` for every sample, independent of this change.

Text-only records raise `KeyError` on `["image"]` and fall through to the existing
`except: return self.__getitem__(random.randint(...))` retry in both versions; Python's `random`
is seeded so the retries are reproducible.

Two configurations: `num_workers=0` (HF Trainer's default `dataloader_num_workers`, which
`finetune_ds.sh` does not change) and `num_workers=4` with the `fork` start method (the Linux
default on Python up to 3.13; on macOS it has to be requested, see caveats).

## Commands

```sh
B=.../bench/OpenBMB__MiniCPM-V
python3 -m venv $B/venv
$B/venv/bin/pip install torch torchvision pillow numpy psutil transformers==4.51.2 \
    deepspeed peft==0.14.0 accelerate==0.30.1 packmem-0.1.0-cp310-abi3-macosx_11_0_arm64.whl
# the repository has no setup.py/pyproject.toml, so it is used from source via sys.path
git -C $B/repo worktree add $B/repo-orig main      # unpatched copy
$B/venv/bin/python -I $B/harness/convert.py llava_v1_5_mix665k.json $B/data/minicpm_665k.json
$B/venv/bin/python -I $B/harness/verify.py $B/data/minicpm_665k.json
$B/harness/bench.sh          # 5 runs x {orig, patched} x {0, 4 workers}, interleaved, fresh process each
$B/venv/bin/python -I $B/harness/summarize.py $B/harness/results.jsonl
```

Each run is `/usr/bin/time -l python run.py --repo <repo-orig|repo> --data minicpm_665k.json --n 20000 --workers <0|4>`.

## Results

Apple M4 Pro, 48 GB, macOS 26, Python 3.12.10, torch 2.15.0. Medians of 5 runs.
"Footprint" is macOS `phys_footprint` (includes compressed pages; RSS on macOS does not).
Worker footprint is reported by each worker itself because macOS does not let a process read
another process's memory counters.

### num_workers=0 (default)

| | `json.load` list | packmem | |
| --- | --- | --- | --- |
| Peak RSS (`time -l`) | 5,326 MB | 945 MB | 5.6x lower |
| Peak memory footprint (`time -l`) | 5,266 MB | 805 MB | 6.5x lower |
| Footprint after the dataset is built | 5,188 MB | 727 MB | |
| Load time (`make_supervised_data_module`) | 4.5 s | 9.1 s | 2x slower |
| 20,000 samples through the DataLoader | 79.7 s | 70.6 s | within run-to-run noise (65-101 s) |
| Wall time, whole process | 92.3 s | 83.7 s | within noise |

### num_workers=4, fork

| | `json.load` list | packmem | |
| --- | --- | --- | --- |
| Main process peak RSS | 5,278 MB | 895 MB | |
| Main process peak footprint | 5,219 MB | 755 MB | |
| Sum of the 4 workers' peak footprints | 2,143 MB | 727 MB | |
| Main + workers | 6,839 MB | 1,439 MB | 4.8x lower |
| Load time | 3.3 s | 7.7 s | 2.3x slower |
| 20,000 samples through the DataLoader | 22.6 s | 22.7 s | same |
| Wall time | 31.0 s | 32.3 s | +1.3 s, the slower load |

### Fixed overhead, for scale

The same harness on the first 20,000 records: 546 MB peak footprint with a list, 423 MB with packmem
(workers=0); the 4 workers sum to 797 MB and 503 MB. So torch, transformers, deepspeed and
the image pipeline account for roughly 350-400 MB in the main process and about 500 MB across
4 workers, and the 665k records cost about 4.8 GB as Python objects against about 0.4 GB packed
(`Table.nbytes` reports 301 MB). The worker copies grow with the number of distinct samples a
worker touches, so over a full epoch the list version's workers would keep growing toward
a full copy each, while this run read only 3% of the records.

On a single 8-GPU node with torchrun, each rank builds its own dataset, so the 4.8 GB is paid
eight times (about 38 GB of host RAM for this dataset) against about 3.3 GB with packmem; this was not
run here (no GPUs) and is arithmetic on the single-process numbers.

## Identical output

- `harness/verify.py` loads the file both ways and compares all 665,298 records: `==`, key
  order, type of `id` and `image`, and `json.dumps` of each record. 0 mismatches
  (612,264 str images, 12,346 dict images, 40,688 without `image`, 72,140 integer ids).
- `run.py` hashes, with SHA-256, every tensor the collator returns for the 20,000 samples
  (`input_ids`, `position_ids`, `labels`, `attention_mask`, every `pixel_values` tensor,
  `image_bound`, `tgt_sizes`). All 10 runs per configuration produced the same hash for both versions:
  `0803e050e386...` (workers=0) and `66c4dbcbe111...` (workers=4). The 20k-record runs match too.
- The repository has no test suite (no `tests/` and no pytest config), so no existing
  tests were run.

## Caveats and where packmem does not help

- **Load is about 2x slower** (4.5 s -> 9 s for 1 GB of JSON). Small compared with a fine-tuning run,
  but it is a regression.
- **Spawn/forkserver workers do not work.** `packmem.Table` cannot be pickled
  (`TypeError: cannot pickle 'packmem._Table' object`). DataLoader workers under the `spawn` or
  `forkserver` start method pickle the dataset, so the patched code fails there. This
  affects macOS and Windows (default `spawn`), and Linux on Python 3.14+, where the
  default start method changed to `forkserver`. It works with `fork`, which is what the Linux
  CUDA setups MiniCPM-V targets use on Python <= 3.13, and with `num_workers=0`. For comparison,
  pickling the list-backed dataset takes 3.3 s and produces 671 MB per worker.
- Per-item cost is unchanged here because image decoding and resizing dominate `__getitem__`;
  packmem's row decode (microseconds) is not visible. Without the one-time `sample = ...`
  read, each item would decode the row three or four times. That is still small but avoidable.
- Images were stubbed with small generated images and the tokenizer is a stub. Real images
  add memory in both versions equally and do not change the dataset numbers; the timings say
  nothing about real throughput.
- The text in this dataset is short English Q&A; the conversations column is stored as JSON
  text, so compression will differ for other data (long documents, non-Latin scripts).
- Below a few thousand records there is no memory gain worth the extra dependency.
- A dependency-free alternative with a similar effect is converting the list to Arrow /
  `datasets.Dataset` (memory-mapped), which also pickles. That is a larger change than
  two lines, but maintainers may prefer it.

## Files

- `packmem.patch`: the diff (committed on branch `packmem-raw-data` in `repo/`)
- `harness/convert.py`, `harness/verify.py`, `harness/run.py`, `harness/bench.sh`,
  `harness/summarize.py`, `harness/pickle_check.py`
- `harness/results.jsonl`: all 20 runs
