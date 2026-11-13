# NVIDIA NeMo Automodel: VLM JSON mixture path, list vs packmem

- Upstream: NVIDIA-NeMo/Automodel, `main` at 0fcccc535 (2026-11-12). Licence: Apache-2.0. `packmem.v2.patch` is a diff of
  `nemo_automodel/components/datasets/vlm/datasets.py` and `vlm/samplers.py` (+19/-17). It packs the converted examples
  into `_ExamplesWithStats(packmem.Table)`, which pickles natively with `.stats`. `packmem.patch` is the earlier version,
  which needed a workaround for subclass pickling.
- Data: LLaVA-1.5 `llava_v1_5_mix665k.json` (665,298 records, from liuhaotian/LLaVA-Instruct-150K), converted by
  `harness/convert.py` to the `images: [path]` layout that NeMo's `regenerate_vlm.py` writes. It goes through
  `make_meta_dataset` and the recipe loader (`VlmDataloaderConfig` with `MetaDatasetConfig`), using the real
  Qwen2.5-VL-3B processor. Images are replaced, identically in both arms, by generated images derived from the path
  (`--fake-image small` for the loader runs; 640x480 "coco" for the pretokenize run).
- Machine: Apple M4 Pro, 48 GB, macOS 26.6.2, Python 3.12, torch 2.15.0, transformers 5.18.0. Memory is
  macOS `phys_footprint`, MB = 10^6 bytes.
- packmem wheel: sha256 593a86b67c339875..., built from the working tree at about 17:49 on 2026-11-13. It contains
  694c651 (two-pass serialiser, so one copy on `to_bytes`/pickle) and `Table.set_column` (ff8adb6). It predates fe785c2.
- Each measurement is a fresh process, with the arms interleaved in each round. Medians of 5 runs (build), 3 runs (pickle,
  loader). The 1-minute load average is recorded per run in `results/phase2.jsonl` (`loadavg`); medians were 2.5-7.6.
  Desktop apps contribute about 2-5.

## Correctness
- All 665,298 per-example digests are identical between arms (`results/digests665k.cmp.txt`; the digest files
  themselves are omitted for size). DistributedSampler hashes are identical (`results/phase2-dump.jsonl`).
- Collated batch hashes are identical between arms in every loader configuration below (`batches_sha` in
  `results/phase2.jsonl`).
- 20k subset (`results/phase1v2-*.jsonl`): identical examples, `.stats`, samplers and collate output, including through
  the recipe path under spawn and fork, with and without `shard_data`.
- Upstream tests with the patch: 532 passed (VLM dataset tests, length-grouped sampler, ViSpec recipe).
  `test_vlm_loader.py` 68/68 with a macOS `sched_getaffinity` shim. No upstream test covers the packmem arm specifically.

## Results (full 665k)

| | list | packmem |
|---|---|---|
| Main process after build | 8,444 MB | 1,239 MB |
| Build time | 20.5 s | 35.5 s |
| shard_data (rank 0 of 8): build / after build | 4.7 s / 3,239 MB | 10.7 s / 577 MB |
| 4 fork workers, 64 batches: sum of worker peaks (largest) | 6,143 MB (1,537) | 486 MB (125) |
| spawn, 1 worker: worker peak | 5,194 MB | 1,202 MB |
| spawn, 1 worker: time to first batch | 14.9 s | 2.5 s |
| spawn, 1 worker: main peak | 10,712 MB | 1,996 MB |
| shard_data + 4 spawn workers: sum of worker peaks | 4,417 MB | 2,364 MB |
| shard_data + 4 spawn workers: time to first batch | 13.3 s | 8.8 s |
| Pickled dataset | 704 MB, dumps 5.07 s, loads 3.52 s | 354 MB, dumps 0.05 s, loads 0.02 s |

## Not run, and how to read the spawn rows
- The full set with 4 spawn workers was not run on the list arm. Each spawn worker unpickles its own full copy of the list
  (5.2 GB), so that run would need about 8.4 + 4 x 5.2 = 29 GB for one process. That leaves too little room on this 48 GB
  machine for the other arm and the OS. Spawn on the full set is therefore reported with 1 worker.
- With packmem, a spawn worker's peak of 1,202 MB is mostly framework imports (torch, transformers, the processor) plus a
  private copy of the 354 MB table. Each spawn worker receives its own copy; only fork shares it.
- Building is about 1.7x slower, mostly from the nested `conversation` field (content lists of dicts), which packmem
  currently stores as JSON text.

## Commands
```sh
# venv: torch, torchvision, transformers, datasets, torchdata, torchao, pillow, pytest + the packmem wheel
# repos: automodel/ = upstream main 0fcccc535; automodel-packmem/ = the same plus packmem.v2.patch
python -I harness/convert.py llava_v1_5_mix665k.json data/llava665k.json      # also writes data/llava665k.meta.json
sh harness/bench.sh verify    # per-example digests, samplers, collate; then cmp of the digest files
sh harness/bench.sh build     # ROUNDS=5
sh harness/bench.sh pickle    # 3 rounds
sh harness/phase2_loader_mac.sh   # the loader runs above, sized to a 48 GB machine (3 rounds)
python -I harness/summarize.py results/phase2.jsonl
```
