# packmem in LLaVA-NeXT `LazySupervisedDataset`: memory benchmark

Upstream commit: `bce12e479bc4dfee2b9c50c88137b01ff51bd483` (2026-06-15). Machine: Apple M4 Pro, 48 GB, macOS 26.6.2, Python 3.12.10, torch 2.15.0, transformers 4.49.0, packmem 0.1.0 (local wheel). Everything ran locally. Nothing was pushed or posted.

## What the code does

`llava/train/train.py::LazySupervisedDataset.__init__` reads the SFT mix: a single JSON file, a `{a,b}.json` brace pattern, or a YAML list of `.json`/`.jsonl` files with `first:N` / `end:N` / `random:N` / `N%` sampling. It keeps every record in `self.list_data_dict`, a Python list of dicts (`id`, `image` or `video`, nested `conversations`). Every training rank builds this list, and its DataLoader workers inherit it. `lengths` and `modality_lengths` walk the whole list once to feed the length-grouped sampler. `_get_item(i)` reads `list_data_dict[i]` a handful of times per sample.

## The change

The patch is `packmem.patch`: 11 insertions and 13 deletions, all in `llava/train/train.py`.

- `self.list_data_dict = packmem.Table()` replaces `[]`.
- `json.load(file)` becomes `packmem.load_json(...)` at the three load sites (the YAML branch passes the path). The `.jsonl` loop becomes `packmem.load_jsonl(json_path)`.
- `first:` and `end:` use `del cur_data_dict[n:]` / `del cur_data_dict[:-n]`, so the selection stays packed. Slicing a Table would return a list of dicts.
- For `random:`, the patch shuffles a list of indices with `random.shuffle`. That consumes the RNG exactly as shuffling the records did, so it picks the same records in the same order. It then packs the picked rows. Calling `random.shuffle` directly on a Table does work, but it took 6.8 s for 50k rows.
- `lengths`, `modality_lengths` and `_get_item` are unchanged.

`llava/train/train_dpo.py` has a copy of the same loader and was not touched.

## Data

The data is synthetic, written by `harness/gen_data.py`, because the real OneVision/LLaVA-1.5 JSONs plus images are too large to download for this. The files follow the real record layout and the source mix of `llava_v1_5_mix665k`:

- templated short-answer VQA: ocr_vqa, gqa, textvqa, vg
- free-form detailed answers: llava_instruct
- multi-image records
- long text-only ShareGPT chats

Text is Zipf-sampled from a 12k-word vocabulary, so it compresses roughly like English but not exactly.

| file | records | size |
| --- | --- | --- |
| `llava_v1_5_mix665k.json` | 665,000 | 761 MB |
| `si_mix.json` | 300,000 | 267 MB |
| `text_mix.jsonl` | 150,000 | 740 MB |

`mix.yaml` takes `all`, `end:200000` and `first:80%` of these files, for **985,000 records**. That is the size of the OneVision single-image stage. The full OneVision SFT mix is about 3.2M records.

## Commands

```
python3.12 -m venv venv
venv/bin/pip install --no-deps -e repo        # the pinned [train] extras (CUDA torch 2.1.2, deepspeed) do not install on macOS
venv/bin/pip install torch "transformers<4.50" pyyaml pillow numpy packaging requests tokenizers psutil \
    packmem-0.1.0-cp310-abi3-macosx_11_0_arm64.whl
venv/bin/python -I harness/gen_data.py data 1.0

# original = worktree of main (repo-orig), patched = branch `packmem` (repo)
harness/run_timing.sh orig 5         # /usr/bin/time -l python harness/bench.py <repo> data/mix.yaml out.json, fresh process each
harness/run_timing.sh patched 5
python harness/summarize.py .
python harness/bench.py <repo> <data_path> out.json --hash    # equivalence check; data_path = mix.yaml, mix_random.yaml, data/{si_mix,llava_v1_5_mix665k}.json, si_mix.json
python harness/fp_lengths.py <repo> <label>                   # phys_footprint after load
python harness/workers.py <repo> <label>                      # 4 forked workers
```

`harness/llava_import.py` imports `llava.train.train` with `deepspeed`, `llava.model` and `llava.train.llava_trainer` stubbed out. The dataset class needs none of them. `bench.py` builds the real `LazySupervisedDataset(data_path, tokenizer=None, data_args)` from the repository code, then calls `.lengths` and `.modality_lengths`. It also runs 10,000 seeded random samples through the same `list_data_dict[i]` lookups that `_get_item` makes for an image sample. Image decoding and tokenization are not run.

## Results (985,000 records, median of 5 fresh processes)

| | list of dicts (original) | packmem (patched) | change |
| --- | --- | --- | --- |
| Peak RSS, `/usr/bin/time -l` | 4,991 MiB (range 4,125 to 5,241) | 1,928 MiB (range 1,895 to 1,992) | 2.6x lower |
| RSS after the dataset is built | 3,674 MB | 1,828 MB | 2.0x lower |
| phys_footprint after build (1 run) | 3,888 MiB | 1,564 MiB | 2.5x lower |
| Same, minus the ~225 MiB of interpreter and torch before load | 3,663 MiB | 1,339 MiB | 2.7x lower |
| Packed size reported by `Table.nbytes` | n/a | 716 MB | |
| `LazySupervisedDataset(...)` construction | 7.9 s | 33.2 s | **4.2x slower** |
| `.lengths` | 5.7 s | 9.6 s | 1.7x slower |
| `.modality_lengths` | 5.4 s | 9.6 s | 1.8x slower |
| `_get_item` record lookups, 10k samples | 6 ms | 179 ms | about 18 µs per sample instead of 0.6 µs |
| Process wall time (whole script) | 25.9 s | 55.7 s | 2.2x slower |

Four workers forked from the process that holds the dataset, as `DataLoader(num_workers=4)` does with the fork start method. Each worker read its quarter of the records with the same lookups. One run:

| | original | patched |
| --- | --- | --- |
| Parent phys_footprint | 3,888 MiB | 1,564 MiB |
| Memory each worker copied by the end of the pass | 2,100 MiB | 693 MiB |
| Sum over 4 workers | 8,398 MiB | 2,775 MiB |
| Parent plus 4 workers | about 12.3 GB | about 4.3 GB |
| Time for one pass over all records | 0.7 s | 2.7 s |

On an 8-GPU node, each rank holds its own copy and its own workers. At this data size that is roughly 98 GB against 34 GB of host memory per node. At the full 3.2M-record mix, both numbers scale about 3.3x.

## Identical-output check

Each configuration ran once in a fresh process per version, with `random.seed(0)`. Every check matched between original and patched, except the key-order hash, which differs for three of the four configurations (explained below):

| data_path | records | lengths | modality_lengths | 10k sampled (id, conversations) | all rows, `json.dumps(sort_keys=True)` | all rows, key order kept |
| --- | --- | --- | --- | --- | --- | --- |
| `mix.yaml` (all / end: / first:%) | 985,000 | identical | identical | identical | identical | **differs** |
| `mix_random.yaml` (random:% and random:N) | 170,000 | identical | identical | identical | identical | **differs** |
| `{si_mix,llava_v1_5_mix665k}.json` | 965,000 | identical | identical | identical | identical | **differs** |
| `si_mix.json` | 300,000 | identical | identical | identical | identical | identical |

For `mix.yaml`, `lengths` hashes to `975655922cf2…` and the sorted-key row hash is `b98466ab5d0a…`, the same in both versions. All record contents are equal. The key-order difference: packmem returns keys in the order columns were first seen across the whole table. In a file that mixes `{"id","image","conversations"}` records with ShareGPT `{"id","model","conversations"}` records, the ShareGPT rows come back as `id, conversations, model`. Nothing in the training code depends on key order, but it is a change.

The repository has no tests for the data pipeline. The only test file, `llava/serve/test_message.py`, exercises the serving code. Full training was not run: there is no CUDA here, and the pinned deepspeed does not install on macOS.

## Caveats and where packmem does not help

- **Load time.** Construction is 4.2x slower, 25 s more per rank at 1M records and on the order of 80 s at 3.2M. Of that, about 7 s per 665k records goes to `packmem.load_json`, which is slower than `json.load` on these nested records (7.2 s against 3.0 s). About 8 s goes to `Table.extend(Table)`, which decodes every row back to a dict and packs it again.
- **Full passes are slower.** `lengths` and `modality_lengths` each take about 1.7x longer. Switching them to `rows.lazy()` only brought one pass from 9.1 s to 8.7 s, because each record's `conversations` value is decoded as a whole, so the patch leaves them as they were.
- **Per-sample lookups** cost about 18 µs per sample, against 0.6 µs. That is negligible beside image decoding and tokenization, but it is not free.
- **Workers still copy memory.** Patched workers still grew about 690 MiB each during a read-only pass. The parent's footprint (1,564 MiB) is well above the table (716 MB) plus the baseline (225 MiB), so the likely cause is freed allocator memory left over from loading being reused, and copied, in each child. I did not investigate further.
- **Pickling.** A `packmem.Table` cannot be pickled, so the patched dataset fails with `spawn` or `forkserver` DataLoader workers. `spawn` is the default on macOS. Python 3.14 makes `forkserver` the default on Linux, and torch uses the multiprocessing default unless `multiprocessing_context` is set. Training on Linux with Python 3.10 to 3.13 uses fork and works.
- **In-place mutation.** In the video branch, `_get_item` assigns `sources[0]["conversations"][0]["value"] = ...` (train.py:1203). With a list, that rewrites the stored record, so repeated reads of the same index in the same worker stack the time instruction again. With a Table each read returns a fresh dict, so the edit does not persist. That is arguably the intended behaviour, but it is a change. No video records were in this benchmark.
- **Synthetic data.** Real captions and ShareGPT text may compress differently from Zipf-sampled words. 97% of the packed bytes are the `conversations` column, so the memory figure depends mostly on how well free text compresses.
- **Dependency.** packmem is an alpha compiled extension, and this would add it as a hard dependency of the training path.
