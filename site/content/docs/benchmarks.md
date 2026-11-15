# Benchmarks

packmem's gain is memory. These measurements put it inside real code: two training scripts, two open-source apps
and a demo, plus a direct comparison with Hugging Face `datasets`. Each one names the code it changed, what it
compared against, and where packmem is slower or only level. Every number below comes from a results file in the repository, next to its raw output.

| | Without packmem | With packmem | |
| --- | ---: | ---: | --- |
| VLM training data, 8 ranks x 4 workers, node memory | 47.81 GiB | 4.47 GiB | 10.7x less |
| Lightdash, 100,000 rows held in the browser | 115.25 MB | 15.52 MB | 7.4x less |
| paperless-ngx exporter, 100,000 documents, peak RSS | 1,191 MiB | 580 MiB | 2.05x less, 2.0x slower |
| Log viewer, 1,000,000 rows until usable | 3,275 ms | 1,327 ms | about the same bytes over the network |
| DataLoader, 4 forkserver workers, vs HF `datasets` (Arrow) | 1,810 MB | 1,144 MB | 37% less; HF faster in batches |

The machine for all of these is a shared Linux server (AMD Ryzen 9 7950X3D, 16 cores, 124 GiB RAM) that also runs CI.
Memory figures held steady across runs; times are noisier and are marked where the load was high.

## VLM fine-tuning: annotation lists in every rank

Training scripts for LLaVA-style vision-language models read the whole annotation file with `json.load` in every
rank, and each DataLoader worker inherits that list. Here the training scripts of Qwen3-VL (qwen-vl-finetune) and
MiniCPM-V read the LLaVA-1.5 665k annotations (1 GB of JSON) through a patch that loads them with
`packmem.load_json` instead. The patch for Qwen3-VL is +29/-12 lines in `data_processor.py`.

8 torchrun ranks with 4 fork workers each. Memory for the whole job (PSS summed over every process), median of 3
runs, packmem 0.3.3:

| Model | Samples per rank | List (`json.load`) | packmem | |
| --- | ---: | ---: | ---: | --- |
| Qwen3-VL | 20,000 | 47.81 GiB | 4.47 GiB | 10.7x less |
| Qwen3-VL | 83,163 (full shard, 1 run) | 54.88 GiB | 6.12 GiB | 9.0x less |
| MiniCPM-V | 20,000 | 37.82 GiB | 7.25 GiB | 5.2x less |

One rank reading a full shuffled epoch through 4 workers, median of 3, packmem 0.3.2:

| | List | packmem | |
| --- | ---: | ---: | --- |
| 4 fork workers | 10.24 GiB | 1.05 GiB | 9.8x less |
| 4 spawn workers | 15.32 GiB | 2.68 GiB | 5.7x less |
| Main process only, 20,000 samples | 4.02 GiB | 1.04 GiB | 3.9x less |

- The batches are bit-identical between the two arms, for all 8 ranks, in every run.
- The figures are host RAM for the annotations and the processes around them: no images, no model, no GPU.
- In 0.3.2 the Qwen3-VL peak at 20,000 samples was 5.77 GiB, above 0.1.0's 4.86 GiB: its loader parses on up to 4
  threads, and glibc kept each thread's freed buffers. 0.3.3 returns them, so the 8 simultaneous loads peak lower.
  The full-shard and MiniCPM-V peaks come from iteration and barely moved (6.21 to 6.12 and 7.31 to 7.25 GiB).
- The 0.3.3 rows were measured on a build of commit 4bf9c3e, which has the same code as the 0.3.3 release; the
  published wheel gives the same one-process loader peak (441 against 442 MiB). The list arms are the 0.3.2 runs,
  since list memory does not depend on packmem.

Details and raw files:
[RESULT-0.3.2.md](https://github.com/HamedMP/packmem/blob/main/benchmarks/ml_swaps/linux-node/RESULT-0.3.2.md).

## Against Hugging Face `datasets` (memory-mapped Arrow)

packmem replaces lists of Python records. It is not a replacement for Arrow, and a memory-mapped Arrow table is
already far smaller than a list. This compares the two directly: one PyTorch DataLoader of 4 workers serving 20,000
random LLaVA-1.5 records (batch size 8, no images or model), with the data from `datasets` 5.2.0 / pyarrow 26.0.1 and
from packmem 0.2.0 saved to a file and opened with `packmem.open()`. Median of 3 runs.

| Forkserver workers | Python list | HF `datasets` | packmem | packmem vs HF |
| --- | ---: | ---: | ---: | --- |
| Memory for the whole job (PSS) | 15,961 MB | 1,810 MB | 1,144 MB | 37% less |
| Anonymous memory above an empty DataLoader | +15,099 MB | +243 MB | +5 MB | |
| Sent to each worker | 687 MB pickle | 2.2 KB | 134 B | |
| First batch | 63.5 s | 1.80 s | 1.02 s | indicative (shared host) |

| | HF `datasets` | packmem | |
| --- | ---: | ---: | --- |
| File on disk (Arrow cache / `.pkm`) | 785 MB | 309 MB | 2.54x smaller |
| The same data as zstd Parquet | 164 MB | | Parquet is smaller at rest |
| Memory each worker adds by importing the library, over torch | +55 MB | +0.2 MB | anonymous memory |
| Memory for the whole job with fork workers | 994 MB | 549 MB | |
| Random row to a Python dict, `x[i]` (packmem 0.1.1) | 22.2 us | 6.05 us | 3.7x faster |
| Batched reads, 64 rows at a time, per row (packmem 0.1.1) | 2.25 us | 4.96 us | HF 2.2x faster |
| One pass in batches of 1,000 (packmem 0.1.1) | 2.0 s | 2.8 s | HF faster |
| First build from the JSON | 22.4 s (conversion) | a `load_json` plus 0.2 s `save()` | |

- Most of HF's gap here is per-process: every forkserver worker imports `datasets` and pyarrow again (about 55 MB
  each), and touches 407 MB of the Arrow file against 176 MB of the `.pkm` file for the same rows.
- HF's batched and columnar paths are faster than packmem's. packmem is faster on the per-row path, which is what
  a map-style DataLoader dataset uses.
- For storage at rest, zstd Parquet is the smaller format. packmem's file is for opening and querying in place.
- packmem took the JSON as it is and round-tripped every record exactly. `datasets` 5.2.0 silently rewrote 158,383
  mixed-type `id` values, even with a string type declared for `id`, so the HF arm reads a copy with the ids written
  as strings first.
- Every arm returned the same batches (one digest over all 24 runs), and the full table's per-record digest is equal
  for HF and packmem.

Details and raw files:
[RESULT_0.2.0.md](https://github.com/HamedMP/packmem/blob/main/benchmarks/ml_swaps/hf-datasets/pypi-0.2.0/RESULT_0.2.0.md)
(memory, file size, import cost) and
[RESULT.md](https://github.com/HamedMP/packmem/blob/main/benchmarks/ml_swaps/hf-datasets/RESULT.md) (access speed).

## Lightdash: a large query in the browser

[Lightdash](https://github.com/lightdash/lightdash) 3.261.1's client fetches query results as 500-row JSON pages. A 25-line
patch to its v2 results endpoint sends the same rows as packmem bytes when the client asks for them, and JSON
otherwise. The browser opens them with `fetchTable` from `packmem/wasm`. The fair comparison is JSON at Lightdash's
2,500-row page limit, gzipped by an nginx proxy in front.

100,000 rows, 17 fields each, median of 5 rounds in headless Chromium:

| | Until usable | Over the network | Held in the browser |
| --- | ---: | ---: | ---: |
| JSON, 2,500-row pages, gzipped | 13.73 s | 4.09 MB | 115.25 MB |
| packmem, 2,500-row pages | 13.46 s | 3.27 MB | 18.69 MB |
| packmem, every row in one response | 11.85 s | 3.25 MB | 15.52 MB |
| JSON, 500-row pages (Lightdash's client today) | 20.57 s | 4.93 MB | 115.18 MB |

- **Memory** in the browser is 6.2x to 7.4x lower.
- **Bytes** are about a fifth fewer than gzipped JSON (1.25x less).
- **Time** barely changes at the same page size: about 12 s of the 13.7 s is Lightdash's server reading and formatting
  rows, which packmem does not touch. One response with every row is 1.16x faster, but it needs Lightdash's page-size
  limit raised.
- Every arm returned the same 100,000 rows (same SHA-256 hash in all 25 runs).

Details, the patch and raw files:
[RESULT.md](https://github.com/HamedMP/packmem/blob/main/benchmarks/apps/lightdash/RESULT.md).

## paperless-ngx: the document exporter

paperless-ngx's `document_exporter` builds its whole manifest as a Python list before writing it. A patched
exporter keeps the manifest in a packmem table. 100,000 seeded documents, `--data-only`, peak RSS of the exporter
process, median of 5 runs, packmem 0.3.2:

| | Peak RSS | Wall time |
| --- | ---: | ---: |
| List | 1,191 MiB | 196 s |
| packmem, `default=` | 660 MiB | 277 s |
| packmem, `default=`, `hint="compact"` | 580 MiB | 400 s |

- **Memory** is 1.80x to 2.05x lower, and every export is byte-identical to the list version's.
- **It is slower:** 1.4x with the default encodings, 2.0x with `hint="compact"`. Times are indicative, since CI raised
  the load in two of the five rounds.
- **At 20,000 documents packmem does worse:** the process peaks 15 to 39 MiB above the list. Importing packmem and
  building the table cost more than the smaller manifest saves.

Details and raw files:
[RESULT-0.3.2.md](https://github.com/HamedMP/packmem/blob/main/benchmarks/apps/paperless-ngx/RESULT-0.3.2.md).

## Log viewer: a million rows in a Next.js page

[demos/log-viewer](/docs/examples/#log-viewer) serves 1,000,000 generated log records with `packmem/http` and scrolls
through them with `useTable` and `useRows`. A switch on the page loads the same rows as JSON with `res.json()`.
Served by `next start` over localhost, packmem 0.3.2 from npm, three runs in headless Chromium:

| | packmem bytes | JSON |
| --- | ---: | ---: |
| Over the network | 31.7 MB (gzip inside the payload) | 32.7 MB (gzip by Next.js) |
| Not compressed | 49.1 MB | 222.1 MB |
| Until usable | 1,327 to 1,471 ms | 3,275 to 3,287 ms |
| Held in the page | a 49.2 MB packed table | 1,000,000 objects |

- **Over the network** the two are about level, because Next.js gzips the JSON. The gain is time until usable.
- **Uncompressed** the bytes are 4.5x smaller than the JSON.
- These are one-off runs at a 1-minute load of 3.6 to 4.3, not a benchmark. The heap readings from these headless
  runs were not consistent, so the page's JS heap is not compared here.

Details: [demos/log-viewer/README.md](https://github.com/HamedMP/packmem/blob/main/demos/log-viewer/README.md).

## Smaller measurements

- 336,776 flight records: a 712 MB Python list against a 20 MB table, on an Apple M4 Pro
  ([benchmarks/results](https://github.com/HamedMP/packmem/tree/main/benchmarks/results)).
- Bytes over the network against JSON, gzip and other formats:
  [benchmarks/wire-size/RESULT.md](https://github.com/HamedMP/packmem/blob/main/benchmarks/wire-size/RESULT.md).
