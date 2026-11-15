# Paperless-ngx `document_exporter` on packmem 0.3.2

**Headline (measured):** `document_exporter --data-only` on 100,000 seeded documents. Peak RSS of the exporter
process, median of 5 runs:

| Arm | Peak RSS | vs list | Held manifest |
| --- | --- | --- | --- |
| A: list | 1,191 MiB | - | 1,001 MiB |
| B: packmem 0.3.2, JSON round trip | 664 MiB | 1.79x lower | 388 MiB |
| C: packmem 0.3.2, `default=` | 660 MiB | 1.80x lower | 383 MiB |
| D: packmem 0.3.2, `default=`, `hint="compact"` | 580 MiB | 2.05x lower | 301 MiB |

Every export is byte-identical to the list arm's. At 20,000 documents packmem's peak is still **above** the list
(see below).

Raw files: [`results-0.3.2/`](results-0.3.2/). The full generated tables, including every run with its load
average, are in [`results-0.3.2/summary.md`](results-0.3.2/summary.md).

## What changed from the first run

[`RESULT.md`](RESULT.md) used packmem 0.2.0 for arm B and a pre-release main build (0.3.0.dev0 at b48a519) for C and
D. This re-run loads the **released 0.3.2 wheel from PyPI** in all three packmem arms (sha256 `2176dd4a...0e163`,
`results-0.3.2/env/packmem-0.3.2.txt`). Same as before:

- Paperless-ngx 3.4.2 image pinned by digest;
- the same patched exporter (sha256 `dc53d9d3...`), selected by `PACKMEM_MODE`;
- the same seed and corpus. The seeded data hashes are identical to the first run's: 100k `ddf0f605...`, 20k
  `dec7cbea...`;
- the same compose override: webserver `mem_limit: 40g`, `cpus: 4`, exporter under `nice -n 10`.

Differences:

- **Postgres.** `postgres:18` resolved to a newer image (`2ea8630d...`, was `b9f6b8ff...`).
- **Fewer runs.** The `--split-manifest` runs were skipped (`SPLIT=0`).
- **Load wait.** Each run waited up to 10 minutes for the 1-minute load average to fall to 4 (`MAXLOAD=4`).
- **Reference hash.** The reference manifest's sha256 differs from the first run's. The 77 `auditlog.logentry`
  records carry the timestamp of the day the database was seeded. Every arm is compared with this run's own arm-A
  reference.

Harness changes (`harness/env.sh`, `setup.sh`, `run.sh`): `PM_B` / `PM_CD` choose the packmem build per arm, with
defaults kept at the first run's. Also added: `SPLIT` and `MAXLOAD`. Command:

```
WORK=~/packmem-paperless-032 PM_B=0.3.2 PM_CD=0.3.2 bash harness/setup.sh && bash harness/seed.sh
WORK=~/packmem-paperless-032 PM_B=0.3.2 PM_CD=0.3.2 SPLIT=0 MAXLOAD=4 ROUNDS=5 bash harness/run.sh
```

## Old vs new, 100,000 documents (median of 5)

| Arm | Peak RSS, first run | Peak RSS, 0.3.2 | Held, first run | Held, 0.3.2 | Table nbytes, first run | Table nbytes, 0.3.2 |
| --- | --- | --- | --- | --- | --- | --- |
| A: list | 1,191 (1,188-1,192) | 1,191 (1,188-1,192) | 1,001 | 1,001 | - | - |
| B: JSON round trip | 825 (813-852), 0.2.0 | **664** (662-676) | 523 | 388 | 370.9 | 328.7 |
| C: `default=` | 766 (763-767), main | **660** (659-679) | 391 | 383 | 329.1 | 328.7 |
| D: `hint="compact"` | 673 (670-676), main | **580** (562-606) | 322 | 301 | 250.0 | 229.4 |

All MiB. With 0.3.2 the JSON round trip (B) costs no memory compared with `default=` (C). It still costs time.

## 20,000 documents (1 run per arm): packmem does worse here

| Arm | Peak RSS, first run | Peak RSS, 0.3.2 | Held, 0.3.2 |
| --- | --- | --- | --- |
| A: list | 365 | 364 | 205 |
| B | 517 (0.2.0) | 403 | 151 |
| C | 509 (main) | 395 | 144 |
| D | 500 (main) | 379 | 129 |

The manifest held in memory is smaller with packmem (1.4-1.6x lower). The process peak is still 15-39 MiB above
the list. Importing packmem and building the table add a fixed cost that 20k documents do not repay. The gap is
smaller than in the first run (135-152 MiB above the list).

## Time (indicative)

Wall time, 100k, median (min-max): A 196.3 s (192.3-291.4), B 277.0 s (275.9-393.4), C 277.1 s (273.3-301.2),
D 399.7 s (396.8-512.0). packmem arms are 1.4x (B, C) and 2.0x (D) slower, as in the first run (C 286.6 s, D 375.5 s).

## Load average

Runs ran 2026-11-15 13:36-16:32 UTC.
- **Rounds 1-3** started at a 1-minute load of 1.0-1.4.
- **Rounds 4-5:** CI jobs raised the load. r4-A and r5-A started at 24-29 after the 10-minute wait ran out; r5-B
  started at 32.8. Others started at 1.1-5.4 but ended at up to 24.
- **Effect on time:** the maxima in the time line above (291 s, 393 s, 512 s) are those runs.
- **Effect on memory:** peak RSS across the 5 runs stays within 4 MiB for A, 14 MiB for B and 20 MiB for C.
  D's 5 runs were 581, 580, 562, 562 and 606 MiB. r5-D, the 606, ended at load 24.

Every run's start and end load is in `results-0.3.2/runs.tsv` and in the "Every run" table of `summary.md`.
