# Where packmem's bytes go, and what would make them smaller

Two parts. **"What 0.3.0 writes"** is the released form, measured with packmem 0.3.0 from npm
(`results/sizes-0.3.0.jsonl`); quote those numbers for the release. Everything from **"Method"** on is the study that
led to it, measured 2026-11-14 on main c3f435f (format 3, before the change), with the writer variants that were
tried: `results/sizes.jsonl` (one line per dataset, row count and variant, with bytes per section) and the tables
derived from it in `results/tables.md` and `results/vs_json_br11.md`. Its "today's form" means format 3, not 0.3.0.

## What 0.3.0 writes

The first recommendation below, varint headers, shipped in **packmem 0.3.0** as format 4 (9bbaf6a). Measured with
0.3.0 installed from npm (`measure_030.mjs`, `results/release-0.3.0.jsonl` and, with Brotli and JSON sizes,
`results/sizes-0.3.0.jsonl`), it writes **byte for byte the size the probe predicted** for the `varint_headers`
variant, in all 24 dataset and size cells. Against format 3 it is 13% to 50% smaller at 10 rows on flights, traces,
logs and issues (3% on chat), 0.3% to 22% at 100 rows, and within 3% from 1,000 rows.

packmem 0.3.0 against the same records as one JSON array:

| dataset | rows | uncompressed | Brotli 11 | Brotli 5 |
| --- | ---: | ---: | ---: | ---: |
| flights | 10 | −69% | +17% | +11% |
| flights | 100 | −89% | −12% | −21% |
| flights | 1,000 | −90% | −16% | −27% |
| flights | 100,000 | −92% | −16% | −38% |
| chat | 10 | −18% | +9% | +9% |
| chat | 100 | −53% | +18% | +8% |
| chat | 1,000 | −50% | +8% | +2% |
| chat | 100,000 | −66% | +8% | +7% |
| issues | 10 | −29% | +10% | +10% |
| issues | 100 | −50% | +11% | +6% |
| issues | 1,000 | −51% | +3% | +3% |
| issues | 3,000 | −61% | −0% | +1% |
| traces | 10 | −56% | +20% | +17% |
| traces | 100 | −77% | −13% | −11% |
| traces | 1,000 | −81% | −19% | −27% |
| traces | 100,000 | −85% | −0% | −17% |
| logs | 10 | −26% | +14% | +19% |
| logs | 100 | −40% | −1% | +10% |
| logs | 1,000 | −44% | −8% | −4% |
| logs | 100,000 | −74% | −6% | −16% |

The 3,000-row cells of every dataset are in `results/sizes-0.3.0.jsonl`.

**Record columns in 0.3.0.** Issues (user, reactions) and traces (attributes) have columns that hold one record per
row. Format 3 and 0.3.0 store a 4-byte offset per row for those, though every row has exactly one record; main
05af6fa (format 5, the next release) drops it. The 0.3.0 numbers above include that overhead. The varint string and
list lengths (recommendation 2) are not in 0.3.0.

### Separately: main 05af6fa (format 5, unreleased)

Built from main 05af6fa and measured the same way (`results/main-05af6fa.jsonl`, `results/sizes-main-05af6fa.jsonl`).
Not a release; kept apart from the 0.3.0 numbers above.

| dataset | rows | uncompressed vs 0.3.0 | Brotli 11 vs 0.3.0 | Brotli 11 vs JSON, 0.3.0 → main |
| --- | ---: | ---: | ---: | ---: |
| traces | 10 | −3.2% | −5.2% | +20% → +14% |
| traces | 100 | −5.6% | −3.0% | −13% → −16% |
| traces | 1,000 | −6.6% | −8.8% | −19% → −26% |
| traces | 100,000 | −8.5% | −0.9% | −0% → −1% |
| issues | 10 to 3,000 | −0.3% to −0.4% | −0.3% to +0.2% | level |

Flights, chat and logs have no single-record columns and write the same number of bytes as 0.3.0; their Brotli 11
sizes move by −0.5% to +1.2% because the format byte differs, which shows how much Brotli 11 varies with a one-byte
change. On issues the record columns are small next to the issue text.

## Method

- **Machine:** Linux 6.8, AMD Ryzen 9 7950X3D (32 threads), 124 GB, rustc 1.100.0, Node v24.22.0
  (`results/machine.txt`). The server was shared and its load average was 47 to 49 during the probe runs and 1 to
  9 during the 0.3.0 and main measurements (`results/load.jsonl`). Only byte counts are reported, and they don't depend on load. Every step ran serially
  under `systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10`.
- **Data** (`prep.py`), 100,000 records each unless noted:
  - `flights`: nycflights13.
  - `chat`: LLaVA-v1.5 mix665k, every 6th record. These hold lists of `{from, value}` turns.
  - `issues`: 3,000 public facebook/react issues as the GitHub API returns them, with nested user, labels and
    reactions.
  - `traces`: synthetic OpenTelemetry-style spans with hex ids and a nested attributes object.
  - `logs`: synthetic service logs with UUIDs, templated messages and decimal timestamps.

  Each table is the first N records of its set.
- **Byte accounting** (`instrument.py`, `probe/`): the core is copied into `build/core` and its writer labels
  every byte by section and kind: length prefix, padding, data or scalar. The probe asserts that the labels add up
  to the total.
  - With no variant switched on, the copy wrote **byte-for-byte the same output as packmem's Node addon** for all
    24 dataset and size pairs, and every output reads back (`check.mjs`, `results/check.txt`).
  - The repository source is not modified.
- **Variants**, switched on in the copy one at a time and together:
  - `fsst_used`: write only the FSST symbols in use, not all 255 slots.
  - `varint_lengths`: string and list offsets written as LEB128 varint lengths.
  - `no_padding`: no alignment padding before vectors.
  - `varint_headers`: counts, length prefixes and chunk metadata as varints, signed values zigzagged.
  - `all_but_fsst`: varint lengths, no padding and varint headers together.
  - `all`: every variant.
- **JSON:** the comparison is the same records as one compact JSON array, as an API sends it. Brotli 1.1.0 at
  quality 11 (static assets) and quality 5 (a typical on-the-fly setting). At 100,000 rows, quality 11 was run only
  for today's form, `all_but_fsst` and `all`.

## Findings

### 1. Uncompressed, packmem is smaller than JSON at every size. After Brotli it loses on small tables and on long text.

| dataset | 10 rows | 100 | 1,000 | 100,000 (3,000 for issues) |
| --- | ---: | ---: | ---: | ---: |
| flights | +27% | −12% | −16% | −16% |
| chat | +10% | +18% | +8% | +9% |
| issues | +12% | +11% | +3% | −0% |
| traces | +23% | −11% | −21% | −0% |
| logs | +20% | +2% | −10% | −7% |

The table shows packmem's size against JSON after Brotli 11. Uncompressed, packmem is 8% to 92% smaller at every
size. With Brotli 5, the 100,000-row structured sets come out 16% to 39% smaller than JSON.

### 2. At 10 rows, fixed-width headers dominate. Above 100 rows, string offsets and string bytes do.

At 10 rows on flights:

| section | bytes | share |
| --- | ---: | ---: |
| chunk metadata | 558 | 30% |
| 8-byte length prefixes | 352 | 19% |
| codes and integers | 494 | 26% |
| strings | 275 | 15% |

Traces and logs at 10 rows look similar: metadata and length prefixes are 22% to 37% of the bytes.

From 100 rows on:
- **Chat, issues and logs:** the string bytes are 82% to 95% of the total.
- **String offsets** (u32 each): 4% to 5% on chat and issues, and 10% to 15% on flights, traces and logs.

The per-section tables are in `results/tables.md`.

### 3. The FSST hypothesis is wrong: writing only the used symbols saves almost nothing

- **Not written for small tables:** below about 100 rows, no string pool trains an FSST table, so tables of 10 rows
  contain no symbol table at all.
- **Few spare slots when written:** tables that have one use most of the 255 symbols. Writing only the used ones
  saves 0% to 0.4% per table. The largest saving is 12 KB on chat at 100,000 rows, which is 0.03%. After Brotli the
  change is within ±0.5%, and sometimes the output gets larger.

It isn't worth a format change on its own, though it costs nothing to include with one.

### 4. Size change of each variant against today's form

| variant | raw, 10 rows | raw, ≥1,000 rows | Brotli 11, 10 rows | Brotli 11, ≥1,000 rows |
| --- | ---: | ---: | ---: | ---: |
| varint string/list lengths | −3% to −11% | −3% to −20% | −4% to −9% | −2% to −14% |
| no padding | −0% to −1% | −0% | −2% to +1% | −1% to +1% |
| varint headers | −3% to −50% | −0% to −3% | −1% to −8% | −0% to +3% |
| all but FSST | −6% to −56% | −3% to −20% | −6% to −16% | −1% to −14% |

- **Varint lengths are the main lever:** Brotli compresses small lengths well but not rising 4-byte offsets. The
  gain is largest on traces and logs from 100 rows up (−7% to −16% at either quality), and on chat at 100,000 rows:
  −16% at quality 5, −8% at quality 11.
- **Varint headers mostly help uncompressed tables:** they halve a 10-row flights table, but Brotli already removes
  most of those zero bytes.
- **Padding barely matters:** it is under 300 bytes per table.

### 5. What the combined change does against JSON, Brotli 11 (`results/vs_json_br11.md`)

| dataset | 10 rows | 100 | 1,000 | 100,000 (3,000 for issues) |
| --- | ---: | ---: | ---: | ---: |
| flights | +27% → +7% | −12% → −21% | −16% → −20% | −16% → −17% |
| chat | +10% → +3% | +18% → +16% | +8% → +6% | +9% → −1% |
| issues | +12% → +6% | +11% → +8% | +3% → −1% | −0% → −5% |
| traces | +23% → +4% | −11% → −24% | −21% → −31% | −0% → −7% |
| logs | +20% → +4% | +2% → −11% | −10% → −17% | −7% → −13% |

The change is varint lengths plus varint headers, with padding left in. Each cell shows today's size against JSON,
then the size with the change.

## Recommendation

1. **Write header integers as varints.** This covers counts, length prefixes and chunk metadata, and needs a FORMAT
   bump.
   - **Gain:** 10-row tables shrink 3% to 50% uncompressed and 1% to 8% after Brotli; larger tables are unchanged.
   - **Cost:** the reader parses these values anyway, so it costs nothing. Vector data stays aligned, which matters
     because padding is computed from the absolute offset, so mapped files still read in place.
2. **Write string and list offsets as varint lengths: the biggest gain, but it has a cost.**
   - **Gain:** 2% to 16% smaller after Brotli, and it closes most of the gap to JSON on text-heavy data. Chat at
     100,000 rows goes from +9% to −1%.
   - **Cost:** the reader must rebuild the offsets array, one pass over the lengths into a new u32 vector. That
     costs time on `from_bytes` and loses the zero-copy offsets of `from_backing` (mmap).
   - **Options:** keep the offsets in place for files, and use lengths only in an HTTP wire variant (a flag byte
     in the header). Or measure the decode cost first: it is one prefix sum, likely small next to Brotli
     decompression in the browser.
   - Not measured here: fixed-width u32 lengths with a prefix sum at read time.
3. **Don't drop the padding.** It's worth 1% at most and is needed for in-place reads.
4. **FSST used-symbols-only:** under 0.4%. Include it only if the format changes anyway.
5. **Even with all changes, Brotli-compressed JSON stays smaller at 10 rows, by 3% to 7%.** The remainder is column
   names and per-chunk metadata that JSON pays once per key, and Brotli handles repeated keys well. For responses of
   a few dozen rows, the JSON fallback in `packmem/http` is the right default.

## Files

- **Scripts:**
  - `prep.py`: data.
  - `instrument.py`: the labelled copy of the core.
  - `probe/`: the accounting binary.
  - `check.mjs`: identity check against the addon.
  - `compress.py`: Brotli and JSON.
  - `summarize.py`: tables.
  - `measure_030.mjs`: what a released (or labelled) build writes.
  - `run.sh`: everything, in order. The probe steps need a checkout of c3f435f, because `instrument.py` edits the
    writer by its exact text; `RELEASE_ONLY=1 ./run.sh` runs only the released-build step, on any checkout.
- **Results** (`results/`):
  - `probe.jsonl`: bytes per section, per dataset, size and variant.
  - `sizes.jsonl`: the same with Brotli and JSON sizes.
  - `release-0.3.0.jsonl`, `sizes-0.3.0.jsonl`: packmem 0.3.0 from npm.
  - `main-05af6fa.jsonl`, `sizes-main-05af6fa.jsonl`: main 05af6fa (format 5), unreleased.
  - `tables.md`, `vs_json_br11.md`
  - `check.txt`, `load.jsonl`, `machine.txt`, `data.txt`
- The data is not in the repository: `run.sh` says where each source comes from, and `prep.py` writes the sets.
