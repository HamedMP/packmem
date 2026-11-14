# A fine-tuning data loader, four ways

Fine-tuning repositories keep their annotations the same way: `json.load` the whole file into a list of dicts,
hand it to a `Dataset`, and let a PyTorch `DataLoader` start workers. Every worker then holds the list too. This
demo runs that loader on real LLaVA instruction data with the annotations held four ways, and measures the parent
and every worker while it runs.

Only the loading line changes. The dataset class is the same in every variant (`dataset.py`):

```python
class ConversationDataset(Dataset):
    def __init__(self, rows):
        self.rows = rows

    def __getitem__(self, i):
        r = self.rows[i]
        text = "\n".join(turn["value"] for turn in r["conversations"])
        return str(r["id"]), len(text.split())   # a whitespace split stands in for the tokenizer
```

```python
# the list every repository uses
with open("llava_instruct_150k.json") as f:
    rows = json.load(f)

# packmem 0.1.2: pack it, and give workers a file instead of a pickled copy
rows = packmem.load_json("llava_instruct_150k.json").share()

# next release: save the packed table once, then open it in place in every run
packmem.load_json("llava_instruct_150k.json").save("annotations.pkm")    # once
rows = packmem.open("annotations.pkm")                                    # milliseconds, memory-mapped

# Hugging Face datasets, for comparison: memory-mapped Arrow
rows = datasets.load_dataset("json", data_files="llava_instruct_150k.json", split="train")
```

## Run it

```sh
pip install torch datasets psutil huggingface_hub packmem
python run.py --mode list            # the default data, llava_instruct_150k.json (229 MB), downloads on first use
python run.py --mode hf
python run.py --mode packmem
python run.py --mode packmem-open    # needs packmem.open(): a build of main until the next release
```

Each run iterates a `DataLoader` with 4 spawn workers over 20,000 seeded random samples and prints one JSON result
(`--workers`, `--start fork|forkserver`, `--samples`, `--file` for another file such as the 1 GB
`llava_v1_5_mix665k.json`). `bench.py` runs every variant three times, interleaved, waiting for a quiet machine
before each run, and `python table.py --write` turns `results/` into the table below.

## Results

<!-- results:begin -->
| Variant | Start | Runs | Peak memory, parent + 4 workers | Above the floor | Each worker, peak | Parent after building | Build | First batch | 20,000 samples |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Floor: no data, just Python, torch and the workers | fork | 1 | **330 MB** |  | 26 MB–28 MB | 218 MB | 0.0 s | 0.0 s | 0.1 s |
| List of dicts, `json.load` | fork | 1 | **1.3 GB** | +957 MB | 28 MB–31 MB | 1.2 GB | 0.4 s | 0.0 s | 0.2 s |
| Hugging Face `datasets`, memory-mapped Arrow | fork | 1 | **341 MB** | +10 MB | 29 MB–30 MB | 220 MB | 0.4 s | 0.0 s | 0.2 s |
| packmem `load_json(...).share()` (0.1.2) | fork | 1 | **476 MB** | +146 MB | 28 MB–30 MB | 357 MB | 1.6 s | 0.0 s | 0.2 s |
| packmem `load_json(...).share()`, next release (0.2.0.dev0) | fork | 1 | **472 MB** | +142 MB | 27 MB–29 MB | 358 MB | 1.6 s | 0.0 s | 0.2 s |
| packmem `open()` of a saved table, next release (0.2.0.dev0) | fork | 1 | **334 MB** | +4 MB | 27 MB–29 MB | 219 MB | 0.0 s | 0.0 s | 0.2 s |
| Floor: no data, just Python, torch and the workers | spawn | 3 | **860 MB** |  | 159 MB–160 MB | 218 MB | 0.0 s | 0.6 s | 0.9 s |
| List of dicts, `json.load` | spawn | 3 | **4.8 GB** | +4.0 GB | 666 MB–668 MB | 1.2 GB | 0.4 s | 4.5 s | 5.0 s |
| Hugging Face `datasets`, memory-mapped Arrow | spawn | 3 | **1.1 GB** | +229 MB | 216 MB–218 MB | 219 MB | 0.6 s | 0.9 s | 1.4 s |
| packmem `load_json(...).share()` (0.1.2) | spawn | 3 | **1.4 GB** | +516 MB | 253 MB–254 MB | 358 MB | 1.6 s | 0.6 s | 0.9 s |
| packmem `load_json(...).share()`, next release (0.2.0.dev0) | spawn | 3 | **1.0 GB** | +142 MB | 160 MB–162 MB | 359 MB | 1.6 s | 0.6 s | 1.0 s |
| packmem `open()` of a saved table, next release (0.2.0.dev0) | spawn | 3 | **865 MB** | +5 MB | 160 MB–161 MB | 219 MB | 0.0 s | 0.6 s | 1.0 s |

llava_instruct_150k.json (157,712 records, 229 MB). darwin arm64, 12 cores, 48 GB; Python 3.12.10, torch 2.15.0, datasets 5.2.0. Memory is phys_footprint (macOS), summed over the parent and its workers at each 0.25 s sample; medians of the runs shown. Load average at the start of each run: 3.2 to 5.2. Batches identical across all 20 runs with data: yes. Built once before the runs: the Arrow cache took 4.2 s, saving the .pkm took 1.7 s.
<!-- results:end -->

## Reading the results

- **What the memory figure counts.** It is phys_footprint, what macOS charges each process for: private, dirty
  and compressed memory. Clean pages of a memory-mapped file are not in it. `datasets`' Arrow cache (184 MB for this
  file) and packmem's saved table (94 MB) sit in the page cache once for the whole machine, however many workers map
  them, and the system can drop and re-read those pages. "Above the floor" subtracts the same loader holding no data:
  Python, torch and the workers by themselves (`--mode floor`).
- **The list** costs 4 GB above the floor with spawn: every worker unpickles its own copy of the list (667 MB each),
  which is also why its first batch takes 4.5 s.
- **packmem 0.1.2's `share()`** gives workers a file instead of a pickle, so the first batch comes in 0.6 s, but
  each worker still loads its own copy of the packed table (about 90 MB) and the parent holds one too: +516 MB.
  **Here `datasets` is better** (+229 MB).
- **In the next release** workers read that file in place: with `share()` they hold nothing beyond the floor and
  only the parent's own table remains (+142 MB). Saving the table once and calling `packmem.open()` in every run
  leaves 5 MB above the floor, against 229 MB for `datasets`, and opening takes no measurable time.
- **Where packmem loses:**
  - Parsing the JSON takes 1.6 s against 0.4 s for `json.load`. `datasets` builds its Arrow cache once (4.2 s) and
    reloads it in 0.6 s; packmem saves its table once (1.7 s) and opens it in no measurable time, but that needs
    the next release.
  - With fork, `datasets` (+10 MB) is level with `packmem.open()` (+4 MB), and both beat `share()`, whose parent
    holds the table it built.
  - Not measured here, but measured against `datasets` on the 665,298-record mix in
    `benchmarks/ml_swaps/hf-datasets`: its batched access (`ds[i:i+64]`, `ds.iter(batch_size=...)`) was about twice
    as fast as packmem's, and its zstd Parquet source is smaller at rest.
- **The `datasets` id trap.** Every id in `llava_instruct_150k.json` is a string, so this file is safe. The 1 GB
  `llava_v1_5_mix665k.json` mixes numbers and strings, and `datasets` 5.2.0's JSON loader rewrites 158,383 of those
  ids without an error (`benchmarks/ml_swaps/hf-datasets/RESULT.md`). `dataset.py` writes the ids as strings first
  when they are mixed; packmem takes the file as it is.
- **`packmem-open` needs `packmem.open()`**, which is on main until the next release. The runs above used a wheel
  built from main (`0.2.0.dev0`, commit 1b4b11d); `run.py` stops with a message on 0.1.2.
- **Scope.** Annotations only: no images, model, real tokenizer or GPU. 20,000 samples, batches of 8, one Mac in
  normal use. The fork rows are single runs.

Reproduce, with packmem 0.1.2 in one environment and a build of main in another:

```sh
python bench.py --python venv-0.1.2/bin/python --python-next venv-main/bin/python --reps 3 --fork-reps 1
python table.py --write
```
