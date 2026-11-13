# packmem: processing data in memory without decompressing it

Nov 13, 2026 · @Hamed

## Summary

Holding records as packed, operation-aware columns cut memory 5 to 10 times against native Rust structs and 26 to 43 times against Python, while most queries ran faster than on uncompressed data. The prototype, `packmem`, is a Rust library and command-line tool; all numbers below were measured in a 2-core Linux sandbox on a synthetic web-access log.

- **Memory.** 300,000 log records (a 75.5 MB JSON-lines file) take 441 MB in Python, 88 MB as Rust structs, 24 MB as LZ4-compressed pages, and 9.9 to 16.6 MB in packmem.
- **Speed.** At 2 million records, string filters and group-by ran 4 to 116 times faster than on plain uncompressed columns (10 to 116 with the speed setting), and a time-range count on the sorted column took 0.2 microseconds. Numeric sums ranged from 1.4 times faster to 2.7 times slower depending on the encoding chosen.
- **Where it loses.** Random point lookups were 1.8 to 4.7 times slower than plain columns, a filtered sum was 2.5 to 3.6 times slower, and equality on a unique-per-row string was 1.2 to 2.2 times slower.
- **Against compress-then-decompress.** packmem was 1.8 to 2.9 times smaller than LZ4 page compression (the zram approach) and at least 3 times faster on every query (up to 180 times on string filters), because nothing is decompressed to be used.
- **On the original question.** A sampling selector picked the smallest encoding on 14 of 14 test distributions in about 1 ms per million values. An LLM is too slow for that decision and is better used offline.

The answer to "can general process memory be processed compressed?" is: not transparently. Arbitrary heap bytes cannot be operated on in compressed form. What works is replacing the containers that hold most of a program's data with encoded ones, and the measurements in the next section show why that is where the memory is.

## Update: Python package tested on real data and real tools

A pip-installable `packmem` now replaces a list of dicts with one line, supports append and update, and on 336,776 real flight records used 17 times less memory than the list it replaced. The wheel was installed with pip into clean environments; publishing is deliberately not done yet.

### What changed in the library

- **Append and update.** Rows land in an uncompressed tail that is packed as the table grows; updates to packed rows go to a small patch map, and heavily patched chunks are re-encoded.
- **Real-world types.** Floats, nulls, missing keys, booleans, nested values, integers beyond 64 bits, and columns whose type changes over time all round-trip exactly.
- **Checked against a model.** A 270,000-row test builds, appends, updates and queries a table alongside a plain list of dicts and requires identical results throughout.

### One-line swap on real flight data (nycflights13, 104 MB as JSON lines)

The swap is `[json.loads(l) for l in f]` to `packmem.load_jsonl(f)`. Times are milliseconds unless marked.

| Holder | Resident MB | Peak MB | Load s | Count by carrier | Sum with filter | Group by dest | Delay over 60 | Sum column | 10k row lookups | Loop all rows |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| List of dicts | 711 | 708 | 1.72 | 45.4 | 57.1 | 52.5 | 45.6 | 45.6 | 3.6 | 43 |
| packmem | 41 | 55 | 1.70 | 1.17 | 2.58 | 0.23 | 4.08 | 0.29 | 20.1 | 341 |
| pandas | 239 | 1,335 | 2.76 | 2.77 | 4.64 | 4.09 | 0.33 | 0.64 | 830 | 2,538 |
| pandas, Arrow-backed | 193 | 288 | 0.43 | 2.13 | 4.49 | 4.26 | 0.46 | 0.37 | 1,674 | 6,026 |
| polars | 127 | 270 | 0.28 | 7.16 | 9.00 | 11.4 | 7.50 | 0.19 | 94 | 496 |

- **Memory:** 17 times less than the list, 5.8 times less than pandas, 3.1 times less than polars.
- **Queries through `where`, `sum`, `group_count`:** 11 to 228 times faster than looping over the list.
- **Unchanged Python loops get slower:** iterating every row is 8 times slower and random row access 5.6 times slower, because each row is rebuilt as a dict on demand. The memory saving needs one line; the speed-up needs the loops rewritten as queries.
- **Dataframes still win some things:** pandas is 12 times faster on the float range filter and polars loads 6 times faster.

On 51,462 real nginx log lines the same swap took resident memory from 57 to 20 MB and made the four filter and group queries 3.5 to 9 times faster.

### Other standard-library swaps (same flight data)

| Before | After | Resident MB | Load s |
| --- | --- | --- | --- |
| `list(csv.DictReader(f))` | `packmem.read_csv(path)` | 450 to 54 | 1.11 to 3.21 |
| `[dict(r) for r in cursor]` (sqlite3) | `packmem.Table(cursor)` | 356 to 43 | 1.46 to 2.73 |

### Two open-source tools, one line changed in each

| Tool and task | Line changed | Time | Peak memory | Output |
| --- | --- | --- | --- | --- |
| sqlite-utils 4.2.1, insert a 104 MB JSON array | `json.load(decoded)` to `packmem.load_json(decoded)` | 12.1 s to 14.5 s | 478 MB to 71 MB | Database identical (schema and full contents hashed) |
| jello 1.6.1, query 104 MB of JSON lines | `[json.loads(i) for i in ...]` to `packmem.load_jsonl(...)` | 5.7 s to 2.3 s | 1,289 MB to 280 MB | Identical |
| jello 1.6.1, query 12 MB of nginx logs | same line | 0.54 s to 0.27 s | 152 MB to 67 MB | Identical |

Both tools are command-line utilities that load records and pass over them once, which is the favourable case. A long-running service that mutates records heavily is not yet tested.

## Update: Apple silicon run and an optimisation pass

The results reproduce on an Apple M4 Pro with identical query answers and packed sizes, and a round of changes then cut packmem's resident memory on the flight data from 49 to 21 MB and its JSON load time from 1.00 to 0.26 s. All figures below are medians of 5 fresh processes on macOS 26.6 (48 GB, Python 3.12); the machine was not idle (load average 3 to 5).

### Flight data, before and after the changes (336,776 rows)

| Measure | List of dicts | packmem as first built | packmem now |
| --- | --- | --- | --- |
| Resident MB | 712 | 49 | 21 |
| Peak MB | 722 | 59 | 30 |
| Load from JSON lines, s | 0.63 | 1.00 | 0.26 |
| Count by carrier, ms | 31 | 0.58 | 0.60 |
| Sum with filter, ms | 35 | 1.56 | 1.32 |
| Group by dest, ms | 59 | 0.13 | 0.20 |
| Delay over 60, ms | 39 | 2.20 | 0.41 |
| 10k row lookups, ms | 5.0 | 13.3 | 11.7 |
| Loop all rows as dicts, ms | 41 | 192 | 155 |
| Loop all rows, lazy rows, ms | n/a | n/a | 25 |

For comparison on the same machine, with default settings and inferred types: Arrow-backed pandas held 215 MB and polars 167 MB (neither was tuned for memory); polars still loads 6 times faster (0.04 s) and pandas is 3 times faster on the delay filter (0.14 ms). On the nginx logs resident memory went from 57 MB (list) to 11 MB (27 MB before the changes).

### What changed

- **JSON is parsed straight into columns.** No intermediate object per record, and strings go into one buffer per column instead of one allocation each.
- **Smaller chunks, packed once.** Chunks are 16,384 rows instead of 65,536, and bulk loads pack each chunk once instead of re-packing the open one as it grows. String compression is also skipped for chunks with under 128 KB of text, where training cost more memory than it saved. Packed size rose 7% on the flight data (7.57 to 8.10 MB).
- **Decimal columns filter on the packed form.** Range and equality on floats stored as scaled integers no longer fall back to a per-row check.
- **Lazy rows.** `rows.lazy()` yields rows that decode a field when it is read and write back on assignment. A loop reading one field runs in 25 ms against 41 ms for the plain list. Plain iteration still builds a dict per record and is 3.8 times slower than the list.
- **Minimum Python is now 3.10**, which lets strings be read without copying; `csv.DictReader` loading went from 1.54 to 0.67 s (the list takes 0.46 s).
- **Fixed:** negative zero lost its sign in decimal-scaled float columns.

### How many rows before it pays off

| Rows (flight data) | List MB | packmem MB | Ratio |
| --- | --- | --- | --- |
| 100 | 0.23 | 0.34 | 0.7 |
| 1,000 | 2.2 | 0.9 | 2.4 |
| 10,000 | 21 | 5.9 | 3.6 |
| 100,000 | 211 | 11 | 19 |
| 300,000 | 633 | 17 | 38 |

packmem breaks even at about 300 records. Below 10,000 the saving is modest because memory used while loading, not the packed data, is most of what the process holds.

### Sort, insert and delete

`sort`, `insert`, `pop`, `reverse`, `clear` and `del` now exist and match a plain list in randomised and property-based tests. Each rebuilds the table, so it costs time proportional to the table's size. The property tests also found two bugs, both fixed: a record with no keys shifted the column order of later records, and `NaN` or `Infinity` in JSON input was rejected where `json.loads` accepts it.

### Where the remaining memory is

Of the 21 MB resident, 8 MB is packed data; the rest is memory the macOS allocator keeps after the load buffers are freed, about 10 to 13 MB regardless of table size. Asking the allocator to release it had no effect. The remaining lever is making the load buffers smaller, for example by de-duplicating repeated strings as they arrive.

### Tools with one line changed, on the Mac

| Tool and task | Time | Peak memory | Output |
| --- | --- | --- | --- |
| sqlite-utils 4.2.1, insert the 104 MB JSON array | 4.85 s to 5.46 s | 604 MB to 67 MB | Database identical (schema and contents hashed) |
| jello 1.6.1, count delayed flights by carrier over 104 MB of JSON lines | 2.54 s to 0.57 s | 1,535 MB to 381 MB | Identical |
| jello 1.6.1, total bytes of 404s in the nginx logs | 0.23 s to 0.09 s | 160 MB to 75 MB | Identical |

The Rust core benchmark on 2 million synthetic records also reproduces (`experiments/results/bench_2m_mac_m4pro.txt`): same answers, same 55 to 90 MB, with plain uncompressed columns still faster on the filtered sum and point lookups.

## Where memory actually goes

Most of a process's memory is structure, not data: pointers, padding, object headers and small counters. I loaded the same 300,000 records into six runtimes, then read each process's resident anonymous memory from `/proc` and classified a 64 MB sample of it word by word.

| Runtime holding the 75.5 MB file | Resident MB | Zero words | Pointers | Small integers | Text | LZ4 page ratio | Zstd page ratio |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Java 21 (HashMap per record) | 675 | 6% | 8% | 27% | 23% | 2.2 | 3.2 |
| Python 3 (dict per record) | 441 | 15% | 25% | 37% | 11% | 5.1 | 8.0 |
| Ruby (Hash per record) | 313 | 34% | 24% | 20% | 11% | 4.5 | 7.0 |
| Node 22 (object per record) | 273 | 1% | 23% | 1% | 62% | 2.7 | 4.1 |
| Redis (hash per record) | 207 | 31% | 26% | 9% | 21% | 3.2 | 5.0 |
| Python parsing its own standard library into syntax trees | 157 | 23% | 44% | 23% | 4% | 3.5 | 5.8 |

Three things follow from this.

1. **Runtimes inflate data 2.7 to 9 times.** A 75.5 MB file became 207 to 675 MB. Between 41% and 90% of the words in every runtime except Node were zeros, pointers or integers under 2^32, which is bookkeeping around the data.
2. **Page compression recovers part of it, at a price.** Compressing 4 KB pages (what zram and zswap do) would shrink these heaps 2.2 to 8 times, but a compressed page must be decompressed before any byte in it is read.
3. **The larger win is not creating the overhead.** The same records in packmem occupy 10.0 to 16.8 MB resident, and LZ4 can only squeeze those pages by a further 1.07 to 1.19. Almost no redundancy is left for a page compressor to find.

The last row is real, non-synthetic data and shows the same pattern: 44% of words are pointers. The Java figures understate pointers because the JVM already stores them as 32-bit values; Node's text share includes strings awaiting garbage collection.

## Design

packmem stores each field of a record collection as one column, picks an encoding for that column from a sample, and runs operations on the encoded form. Three ideas carry the result.

**1. A small vocabulary of encodings that compose.** Every encoding keeps O(1) or O(log n) access to a single value, so nothing is ever unpacked in bulk.

| Encoding | What it stores | Operations that run on the encoded form |
| --- | --- | --- |
| Constant | One value and a length | Everything, in constant time |
| Frame of reference | Value minus the column minimum, in 8/16/32-bit or exact-width fields | Sum, range filter and equality directly on the narrow codes |
| Sorted dictionary | Distinct values once, plus a small code per row | Range and equality become code comparisons; sum is a histogram of codes |
| Run-length | One (value, end) pair per run | Sum and count touch each run once |
| Block frame of reference | Per 1,024 values: own minimum and bit width | Sorted data: range count by binary search over block minimums |
| String dictionary | Distinct strings once, plus codes | Any predicate is evaluated once per distinct string, then codes are scanned; group-by is a histogram |
| FSST strings | Frequent substrings replaced by 1-byte codes; each string decodes alone | Equality by encoding the search term once and comparing bytes; other predicates decode one string at a time into a reused buffer |

**2. The choice depends on the operation, expressed as a hint.** The caller says `Memory`, `Balanced` or `Speed`. The selector estimates bits per value for each encoding from 64 sampled runs of 256 values, multiplies by an access-cost penalty for the hint, and takes the minimum. `Speed` also rounds field widths up to 8, 16 or 32 bits so loops vectorise; `Memory` uses exact bit widths.

**3. Predicates are pushed into the encoding.** "User agent contains curl" over 2 million rows tests 32 distinct strings, then scans 2 million one-byte codes. "Timestamp between A and B" on a sorted column is two binary searches. This is why several queries beat uncompressed data.

The approach is established in analytical databases; BtrBlocks and its Rust descendant in Vortex chain lightweight encodings chosen by compressing a sample ([Vortex](https://vortex.dev/blog/btrblocks-compressor)), and FSST gives per-string random access at roughly 2 times compression on text ([Boncz, Neumann, Leis](https://www.vldb.org/pvldb/vol13/p2649-boncz.pdf)). What packmem adds is applying it to ordinary program memory behind a container API, with the operation hint steering the choice.

## Results

packmem used the least memory of every representation tested and was fastest on five of eight queries; plain uncompressed columns won the other three. All seven representations returned identical answers, which the benchmark asserts.

### Memory and query time at 2 million records (503 MB file)

Times are the median of 9 runs in milliseconds, single thread. Memory is exact live heap bytes from a counting allocator.

| Representation | MB | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dynamic values (how scripting runtimes hold parsed JSON) | 1,665 | 375 | 347 | 439 | 470 | 75.5 | 359 | 256 | 363 |
| Native structs, one per record | 589 | 10.7 | 30.8 | 145 | 169 | 1.26 | 22.5 | 11.1 | 46.1 |
| Plain columns, uncompressed | 589 | 1.20 | 7.95 | 76.2 | 87.6 | 1.02 | 1.48 | 0.72 | 5.35 |
| Plain columns in LZ4 4 KB pages (decompress to use) | 160 | 21.5 | 45.5 | 120 | 96.3 | 225 | 13.3 | 8.46 | 40.8 |
| packmem, Memory hint | 55.5 | 4.24 | 1.97 | 1.86 | 1.92 | 4.81 | 0.0002 | 1.92 | 9.25 |
| packmem, Balanced hint | 57.0 | 4.35 | 0.83 | 1.90 | 1.98 | 4.64 | 0.0002 | 1.86 | 12.0 |
| packmem, Speed hint | 90.1 | 3.02 | 0.79 | 0.66 | 0.81 | 1.85 | 0.0002 | 0.51 | 6.34 |

| Query | What it does |
| --- | --- |
| Q1 | Sum of `bytes` where `status` = 404 |
| Q2 | Count of rows whose `path` starts with `/api/v1/search` |
| Q3 | Count of rows whose user agent contains `curl` |
| Q4 | Group by `country`, count |
| Q5 | 100,000 random row lookups (user id and path) |
| Q6 | Count of rows in a 1% time window |
| Q7 | Sum of `latency_us` |
| Q8 | Count of rows where `session` equals one value (unique per row) |

Reading the table:

- **Against native structs**, the Speed hint is 6.5 times smaller and faster on seven of eight queries, by 3.5 to 220 times on Q1 to Q4 and Q7; only point lookups (Q5) are slower, by 1.5 times.
- **Against plain columns**, packmem wins where the encoding does the work (Q2, Q3, Q4, Q6, and Q7 with Speed) and loses where it adds a step per value (Q1, Q5, Q8).
- **Against LZ4 pages**, random access is the starkest gap: 225 ms against 1.85 to 4.81 ms, because nearly every lookup decompresses a page.

### Memory across runtimes at 300,000 records (75.5 MB file)

| Holder | MB | Measure |
| --- | --- | --- |
| Java HashMaps | 675 | Resident |
| Python dicts | 441 | Resident |
| Ruby Hashes | 313 | Resident |
| Node objects | 273 | Resident |
| Rust dynamic values | 250 | Live heap |
| Redis hashes | 207 | Resident |
| Rust structs | 88.3 | Live heap |
| Plain columns, LZ4 4 KB pages | 24.0 | Live heap |
| Plain columns, Zstd level 3, 64 KB blocks (size only) | 12.6 | Compressed bytes |
| packmem Speed | 16.8 | Resident |
| packmem Balanced | 10.2 | Resident |
| packmem Memory | 10.0 | Resident |

packmem with the Memory hint is smaller than Zstd over 64 KB blocks while remaining directly queryable. For context across languages, the same Q1, Q3 and Q7 took 45, 51 and 28 ms in Python and 3.3, 15.6 and 3.1 ms in Node at this size, against 0.65, 0.29 and 0.25 ms in packmem Balanced; language speed accounts for part of that gap.

## Choosing the encoding

The sampling selector matched an exhaustive search on all 14 test distributions and ran 6 to 37 times faster than trying every encoding. Each distribution had 1 million values: constant, uniform at four widths, 5 distinct wide values, Zipf-like ids, sorted timestamps, long and short runs, clustered, outliers, signed, monotonic ids, booleans.

| Measure | Result |
| --- | --- |
| Selector picks the smallest encoding | 14 of 14 |
| Time to decide, per million values | 1.05 to 1.57 ms |
| Time to encode with all four candidates and compare | 9 to 41 ms |

Most of the decision time is one pass for minimum, maximum and sortedness; the sample itself is 16,384 values.

### The best encoding depends on the operation

No encoding wins every column of this table, which is the case for a hint. Costs are nanoseconds per value (per lookup for random get), 1 million values.

| Data | Encoding | Bits per value | Sum scan | Random get | Range count |
| --- | --- | --- | --- | --- | --- |
| Sorted timestamps | Plain 64-bit | 64 | 0.33 | 3.5 | 0.80 |
| Sorted timestamps | Frame of reference, 32-bit | 32 | 0.26 | 3.4 | 1.03 |
| Sorted timestamps | Frame of reference, 24-bit packed | 24 | 0.98 | 4.7 | 1.41 |
| Sorted timestamps | Block frame of reference | 14.1 | 0.78 | 5.2 | under 0.001 |
| Long runs | Plain 64-bit | 64 | 0.29 | 2.9 | 0.67 |
| Long runs | Frame of reference, 8-bit | 8 | 0.12 | 0.8 | 0.49 |
| Long runs | Run-length | 0.63 | 0.002 | 10.1 | 0.002 |
| Zipf-like ids | Plain 64-bit | 64 | 0.29 | 2.9 | 0.61 |
| Zipf-like ids | Frame of reference, 32-bit | 32 | 0.17 | 2.4 | 0.86 |
| Zipf-like ids | Dictionary, 10-bit codes | 10.1 | 0.99 | 2.0 | 1.05 |
| Zipf-like ids | Block frame of reference | 9.6 | 0.97 | 4.6 | 3.51 |

Run-length is 100 times smaller and 150 times faster to sum than plain storage on long runs, and 3.5 times slower for random access. Byte-aligned frame of reference beats plain 64-bit storage on sums and lookups at half the memory or less, though not on range counts. Exact-width bit packing costs about 3 times on scans in this prototype, which uses a scalar unpacking loop.

## Where an LLM fits

Not in the per-column decision. The selector above decides in about a millisecond per million values and matched the oracle on every distribution tested; a language model call costs tens of milliseconds to seconds and has nothing more to see than the same statistics.

An LLM is useful in three slower loops, none of which this study tested:

- **Recognising semantic types.** In the benchmark, `session` (16 hex characters) and `ip` are 59% to 66% of packmem's bytes because they are stored as text. Recognising the session token as a 64-bit number would take it from 12.4 to 8 bytes per row, about 16% off the total at 2 million rows; it is random, so 8 bytes is its floor. This is a one-time judgement per schema.
- **Writing operators.** Each encoding needs code for each operation. Generating and testing those kernels, including vectorised bit unpacking, is offline engineering a model can do.
- **Migrating code.** Rewriting loops over `Vec<Record>` into column operations is mechanical and suits an agent with a test suite.

If a learned selector is wanted later, the right shape is a small decision tree trained on (statistics, operation mix, measured cost), not an LLM.

## Using it and migrating to it

A new program builds a table from records and calls column operations; an existing program swaps a `Vec<i64>` or `Vec<String>` for the packed equivalent one field at a time.

```rust
use packmem::{Hint, PackedInts, PackedStrs, Table};

// Drop-in for a numeric vector
let latency = PackedInts::encode(&values, Hint::Balanced);
latency.get(42);                    // one value, no bulk decode
latency.sum();                      // computed on the encoded form
latency.count_range(1_000, 5_000);  // filter on codes

// Drop-in for a string vector
let agents = PackedStrs::encode(&strings, Hint::Balanced);
agents.count_where(|s| s.starts_with(b"curl"));
agents.group_count();

// Whole record collections from JSON lines
let t = Table::from_jsonl(reader, Hint::Speed)?;
let mut rows = vec![];
t.int("status").select_range(404, 404, &mut rows);
t.int("bytes").sum_at(&rows);
```

The command-line tool does the same without writing code:

```
$ packmem stats logs.jsonl
300000 rows, 11 columns, hint=Balanced
column      encoding                 bytes  bits/row
country     dict(10)/4bit           150072      4.00
path        dict(1856)+fsst/11bit   429662     11.46
ts          blockfor/sorted         492085     13.12
...
total packed: 9.73 MB  (source file 75.50 MB, 7.8x smaller)

$ packmem query logs.jsonl --eq status=404 --contains ua=curl --sum bytes
37823640
$ packmem query logs.jsonl --prefix path=/api/v1/search --group country
```

Migration cost in practice:

| Existing code | Change needed |
| --- | --- |
| Read-mostly numeric or string vectors | Swap the type; indexing becomes `.get(i)` |
| Loops that filter, count, sum or group | Replace the loop with the column operation to get the speed-up; `.get(i)` loops still work, slower |
| Collections of structs | Move to a `Table`, or one packed column per field |
| Data mutated in place | Not supported; keep those fields in ordinary containers |

## Limits and next steps

These results come from one synthetic dataset on one machine, and the prototype is read-only. Treat the ratios as evidence the approach works, not as numbers a real workload will reproduce.

**What the study does not show**

- **Real data.** The generated log favours dictionaries: `path` has 4,201 distinct values in 2 million rows. Columns of unique random strings gain little; `session` went from 160 to 99.5 bits per row.
- **macOS or ARM.** Now run on one Apple M4 Pro (see the Apple silicon update); the original tables ran in a 2-core x86 Linux sandbox. Individual timings varied by up to about 50% between benchmark runs; medians of 9 are reported.
- **Writes.** Append and update are incremental; sort, insert and delete rebuild the table. Encoding 2 million rows took about 1 second.
- **Other shapes of data.** The Python package handles floats, nulls and nesting; the original Rust table and its benchmarks cover only flat records of integers and strings.
- **Unmodified programs.** A binary that is not changed gains nothing. For that case page compression (zram, zswap, the macOS compressor) remains the tool, and the two combine.
- **Like-for-like memory.** Other runtimes are measured as resident memory, Rust baselines as live heap bytes. The heap count omits allocator overhead, which favours the baselines.

**What to build next, in order of expected gain**

1. **Python bindings.** Done for Linux; see the update section. Next is a Node package and macOS wheels.
2. **Appends and updates** are done, and lazy rows cover fast iteration; incremental sort, insert and delete are the remaining gap.
3. **A derive macro** so `#[derive(Packed)]` on a struct generates the column layout, making migration a one-line change.
4. **Vectorised kernels** for bit unpacking and fused filter-plus-aggregate, to close the gap on Q1 and Q7.
5. **Semantic types**: hex tokens, IP addresses, UUIDs, timestamps as text, and floats.
6. **Validation on real datasets** and on Apple silicon.

## Sources

All measurements in this report are from the attached source code and its recorded outputs. Published work used for design and context:

- [BtrBlocks compressor in Vortex](https://vortex.dev/blog/btrblocks-compressor): cascading lightweight encodings chosen by compressing a sample of roughly 1% of the data; filters evaluated on encoded columns.
- [FSST: Fast Random Access String Compression](https://www.vldb.org/pvldb/vol13/p2649-boncz.pdf) (Boncz, Neumann, Leis, VLDB 2020): the string scheme used here, via the `fsst-rs` crate.
- [JEP 192: String Deduplication in G1](https://openjdk.org/jeps/192): reports about 25% of live Java heap data as String objects, roughly half of them duplicates, consistent with the text share measured here.
- [Arch Linux wiki, zswap](https://wiki.archlinux.org/title/zswap): cites a typical compression ratio around 3.6 for the zsmalloc pool, in the range of the page ratios measured here.
- [Virtual memory compression](https://en.wikipedia.com/wiki/RAM_compression): summarises studies finding 2:1 to 2.5:1 for program data.
