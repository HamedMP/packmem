# Paperless-ngx `document_exporter`: document manifest as a list vs packmem.Table

**Headline (measured):** `document_exporter --data-only` on 100,000 seeded documents, peak RSS of the exporter process (median of 5 runs): A (list) 1,191 MiB; B 825 MiB (1.4x lower); C 766 MiB (1.6x lower); D 673 MiB (1.8x lower). See the tables for the manifest held in memory and for correctness.

MiB = 2^20 bytes. Peak RSS is `Maximum resident set size` from GNU `time -v` around `python3 manage.py document_exporter`. Held manifest is RSS after `gc.collect()` once every document is in the manifest, minus RSS after `gc.collect()` just before the first record is read (probe lines in the patched exporter).

## Versions and environment

**host.txt**

```
date: 2026-11-14T02:44:47Z
kernel: Linux 6.8.0-139-generic x86_64
host glibc: ldd (Ubuntu GLIBC 2.39-0ubuntu8.9) 2.39
cpus: 32
mem: 124 GB
docker: 29.1.3
compose: 2.40.3+ds1-0ubuntu1~24.04.1
loadavg: 10.81 13.74 18.34
```

**container.txt**

```
python: 3.14.9 cpython-314-x86_64-linux-gnu -
glibc: ldd (Debian GLIBC 2.41-12+deb13u4) 2.41
os: Debian GNU/Linux 13 (trixie)
paperless: 3.4.2
django: 5.2.18
psycopg: 3.3.4
exporter (pristine) sha256: 4fff582ed9f2d5f55ec9cc75a4adb01571483e761d2940b21eccb923e01acf9e
exporter (patched) sha256: dc53d9d3ace936b9c85d2bd85dbb42448c77ac17115374ae973f83a26b4ca304
```

**image-digests.txt**

```
docker.io/valkey/valkey:9-alpine valkey/valkey@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b
docker.io/library/postgres:18 postgres@sha256:b9f6b8ff03b62f3cfd9d9ba3fe56226a9991c79d3fb46fd46536263bf02be553
ghcr.io/paperless-ngx/paperless-ngx:3.4.2@sha256:d704e84f88300eb6ab001ab15720a2330ff99169cf9f94d6b8fcc44b63a84c84 ghcr.io/paperless-ngx/paperless-ngx@sha256:d704e84f88300eb6ab001ab15720a2330ff99169cf9f94d6b8fcc44b63a84c84
```

**images-pulled.txt**

```

```

**packmem-0.2.0.txt**

```
packmem 0.2.0: packmem-0.2.0-cp310-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl sha256=09c5ba04ee380af34600af1c9d6fac3f3a0337ebeb19f75292eb6423633614c7
```

**packmem-main.txt**

```
packmem main: commit b48a51992985c8d2a441c191550b18265f27963a
wheel: packmem-0.3.0.dev0-cp310-abi3-manylinux_2_34_x86_64.whl sha256=61ce0b639a14bfe26139e8ec38b05711146b82cee9381eddb5d05367e41d4ac8
rustc: rustc 1.100.0 (0ef1bc386 2026-11-09)
maturin: maturin 1.9.6
container imports packmem 0.3.0.dev0 /opt/packmem/main/packmem/__init__.py
```

**gnu-time.txt**

```
time (GNU Time) UNKNOWN
```

**smoke-b.txt**

```
off: 6692781 bytes sha256=0835002404e940e3
b: 6692781 bytes sha256=0835002404e940e3 byte-identical=True parsed-equal=True
```

**smoke-cd.txt**

```
off: 6692781 bytes sha256=0835002404e940e3
c: 6692781 bytes sha256=0835002404e940e3 byte-identical=True parsed-equal=True
d: 6692781 bytes sha256=0835002404e940e3 byte-identical=True parsed-equal=True
c: extend without default= rejects datetimes, as expected
```

## Method

- Paperless-ngx v3.4.2, published image pinned by digest (above). Paperless's own `docker/compose/docker-compose.postgres.yml` with an override: no published port, webserver `mem_limit: 40g`, `memswap_limit: 40g`, `cpus: 4`, scheduled Celery tasks disabled, and the patched `document_exporter.py` bind-mounted read-only over the image's copy (the image's copy was checked to be byte-identical to v3.4.2 before patching). Compose project `packmem-paperless`.
- One patched exporter for all arms, selected by `PACKMEM_MODE` (`off`, `b`, `c`, `d`); packmem versions come from unpacked wheels on `PYTHONPATH` (none for A). The patch replaces `document_manifest: list[dict] = []` and its `extend`; nothing else changes. The patch itself is not kept in this repository: Paperless-ngx is GPL-3.0 and a diff carries its lines. The seed corpus (Project Gutenberg texts) is not kept either; `harness/seed.py` says which texts it uses.
  - A: `document_manifest = []`, `extend(batch)`.
  - B: `packmem.Table()`, `extend(json.loads(json.dumps(batch, cls=DjangoJSONEncoder)))` (0.2.0 has no `default=`).
  - C: `packmem.Table(hint="balanced")`, `extend(batch, default=DjangoJSONEncoder().default)`.
  - D: C with `hint="compact"`.
- Command, run as the `paperless` user inside the webserver container: `nice -n 10 /usr/bin/time -v python3 manage.py document_exporter <dir> --data-only --no-progress-bar` (plus `--split-manifest` for the split runs; `PAPERLESS_DBNAME=paperless_20k` for 20k).
- Order: one warm-up export (arm A, used as the reference output), then 5 rounds of A, B, C, D with the starting arm rotated each round; then one `--split-manifest` run per arm; then a warm-up and one run per arm on the 20,000-document database.
- Correctness: sha256 of `manifest.json` (or of the sorted per-file sha256 list for `--split-manifest`) against the reference A output; any mismatch is parsed and compared field by field (`compare.py`).
- The server also runs CI; load average at the start and end of every run is listed. Memory is the result; timings are indicative.

## Data

| | 100k | 20k |
| --- | --- | --- |
| documents | 100,000 | 20,000 |
| content_chars_total | 579,805,732 | 118,192,366 |
| content_chars_mean | 5798.1 | 5909.6 |
| content_chars_median | 1,956 | 2,004 |
| content_chars_p90 | 13,266 | 13,448 |
| content_chars_p99 | 61,125 | 62,178 |
| content_chars_max | 200,000 | 200,000 |
| content_empty | 1,018 | 210 |
| content_utf8_bytes_total | 588,196,241 | 119,916,661 |
| content_cpython_sizeof_total | 868,161,668 | 177,477,953 |
| content_kinds | {'ascii': 25218, 'latin1': 33265, 'ucs2': 41517} | {'ascii': 4995, 'latin1': 6651, 'ucs2': 8354} |
| tag_links | 185,768 | 37,432 |
| data_sha256 | ddf0f605d6528cdc456ee3eb6d918e46947eb5f63727e9cd24890de81707670f | dec7cbea908aa193f2edba1270b511c45243ad8b2d45d8d6d2d73409c302ed9e |
| seconds | 75.2 | 16.1 |

Seed 20261114; log-normal content length mu=7.6009, sigma=1.4823, capped at 200,000 chars; text cut from Project Gutenberg (English: pg1342, pg2701, pg84, pg1661; German: pg2229, pg22367, pg5323, pg69327, pg2407), about a third with flattened typography. 25 correspondents, 12 document types, 40 tags (0-4 per document). No files (`--data-only`).

Corpus sha256: `{"pg2229.txt": "fed2a58edd6910ee96d27ada614d34bcc41f03750d86541c41246bb74c564ff7", "pg22367.txt": "359d3f5983c812393f4bd7ee49a350ffffc7d476015e58d6b84b6c848dd2b0e9", "pg5323.txt": "fc2cc841038004b845426452f808e6537045604d66d2878c7007a8909e9240df", "pg69327.txt": "0254e2e361fca684887374ed3e4e4c32f03ac5b7022f54e9a128d1bff6b35b80", "pg2407.txt": "3642f9c98c1bbca55adf25296f4f623bda69c6d47cff46ed5f423053816a19c4", "pg1342.txt": "3f6bb9d6f78e0293b56acd4714dd68cb7d6d1d293402031ce9d5a216bcaf9d75", "pg2701.txt": "b5e88b71a1cda068e9ab1d94344c9d932338ba6da1a66def97a1aecd9cfcc87d", "pg84.txt": "2b97b7f8aad508649481d8dd4f6b54f9b965ddb3ba634e9151c815f537b49e42", "pg1661.txt": "922e2a12ccb43a4c9544c260b2166c6ad2097aeb5957faeee113f173bb857cd0"}`

Database 100k: `546 MB|100000|579805732` (size, documents, sum of content length)

Database 20k: `132 MB|20000|118192366` (size, documents, sum of content length)

## 100,000 documents, manifest.json

| Arm | Runs | Peak RSS MiB, median (min-max) | vs A | Held manifest MiB, median | vs A | Table nbytes MiB | Wall s, median (min-max) | Output vs reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: list (unmodified) | 5 | 1,191 (1,188-1,192) | - | 1,001 | - | - | 199.5 (196.7-228.0) | identical |
| B: packmem 0.2.0, JSON round trip | 5 | 825 (813-852) | 1.44x lower | 523 | 1.9x lower | 370.9 | 272.9 (267.2-293.0) | identical |
| C: packmem main, `default=` | 5 | 766 (763-767) | 1.55x lower | 391 | 2.6x lower | 329.1 | 286.6 (284.7-304.5) | identical |
| D: packmem main, `default=`, `hint="compact"` | 5 | 673 (670-676) | 1.77x lower | 322 | 3.1x lower | 250.0 | 375.5 (369.1-397.1) | identical |

## 100,000 documents, --split-manifest (1 run per arm)

| Arm | Runs | Peak RSS MiB, median (min-max) | vs A | Held manifest MiB, median | vs A | Table nbytes MiB | Wall s, median (min-max) | Output vs reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: list (unmodified) | 1 | 1,192 (1,192-1,192) | - | 1,001 | - | - | 318.8 (318.8-318.8) | reference |
| B: packmem 0.2.0, JSON round trip | 1 | 814 (814-814) | 1.46x lower | 514 | 1.9x lower | 370.9 | 392.2 (392.2-392.2) | identical |
| C: packmem main, `default=` | 1 | 762 (762-762) | 1.57x lower | 388 | 2.6x lower | 329.1 | 402.7 (402.7-402.7) | identical |
| D: packmem main, `default=`, `hint="compact"` | 1 | 704 (704-704) | 1.69x lower | 368 | 2.7x lower | 250.0 | 506.6 (506.6-506.6) | identical |

## 20,000 documents, manifest.json (1 run per arm)

| Arm | Runs | Peak RSS MiB, median (min-max) | vs A | Held manifest MiB, median | vs A | Table nbytes MiB | Wall s, median (min-max) | Output vs reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: list (unmodified) | 1 | 365 (365-365) | - | 205 | - | - | 42.5 (42.5-42.5) | identical |
| B: packmem 0.2.0, JSON round trip | 1 | 517 (517-517) | 0.70x lower | 248 | 0.8x lower | 76.2 | 54.7 (54.7-54.7) | identical |
| C: packmem main, `default=` | 1 | 509 (509-509) | 0.72x lower | 177 | 1.2x lower | 67.8 | 57.6 (57.6-57.6) | identical |
| D: packmem main, `default=`, `hint="compact"` | 1 | 500 (500-500) | 0.73x lower | 145 | 1.4x lower | 51.0 | 74.2 (74.2-74.2) | identical |

## Scaling 20k -> 100k

| Arm | Held MiB at 20k | Held MiB at 100k | Ratio | Peak RSS MiB at 20k | at 100k |
| --- | --- | --- | --- | --- | --- |
| A | 205 | 1,001 | 4.88 | 365 | 1,191 |
| B | 248 | 523 | 2.11 | 517 | 825 |
| C | 177 | 391 | 2.22 | 509 | 766 |
| D | 145 | 322 | 2.22 | 500 | 673 |

## Every run

| Label | Arm | Scale | Split | Start (UTC) | Load start | Load end | Exit | Wall s | Peak RSS MiB | Held MiB | packmem | Output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| warmup-100k | A | 100k | 0 | 2026-11-14T02:47:26Z | 9.56 12.35 17.09 | 8.93 10.57 15.38 | 0 | 223.94 | 1,189 | 1,001 | - | reference |
| r1-A-100k | A | 100k | 0 | 2026-11-14T02:51:10Z | 8.61 10.47 15.32 | 9.50 9.60 13.88 | 0 | 227.97 | 1,188 | 1,001 | - | identical |
| r1-B-100k | B | 100k | 0 | 2026-11-14T02:54:59Z | 9.50 9.60 13.88 | 6.71 7.57 11.82 | 0 | 293.02 | 813 | 513 | 0.2.0 | identical |
| r1-C-100k | C | 100k | 0 | 2026-11-14T02:59:53Z | 6.71 7.57 11.82 | 5.58 6.30 10.06 | 0 | 304.53 | 763 | 391 | 0.3.0.dev0 | identical |
| r1-D-100k | D | 100k | 0 | 2026-11-14T03:04:59Z | 5.58 6.30 10.06 | 4.82 5.21 8.24 | 0 | 397.05 | 673 | 322 | 0.3.0.dev0 | identical |
| r2-B-100k | B | 100k | 0 | 2026-11-14T03:11:37Z | 4.82 5.21 8.24 | 4.11 4.53 7.17 | 0 | 275.24 | 815 | 513 | 0.2.0 | identical |
| r2-C-100k | C | 100k | 0 | 2026-11-14T03:16:13Z | 4.11 4.53 7.17 | 8.89 6.10 6.98 | 0 | 294.34 | 766 | 393 | 0.3.0.dev0 | identical |
| r2-D-100k | D | 100k | 0 | 2026-11-14T03:21:08Z | 8.89 6.10 6.98 | 2.93 3.78 5.58 | 0 | 384.87 | 670 | 322 | 0.3.0.dev0 | identical |
| r2-A-100k | A | 100k | 0 | 2026-11-14T03:27:34Z | 2.93 3.78 5.58 | 3.34 3.47 5.08 | 0 | 201.61 | 1,192 | 1,001 | - | identical |
| r3-C-100k | C | 100k | 0 | 2026-11-14T03:30:56Z | 3.34 3.47 5.08 | 2.11 3.07 4.52 | 0 | 284.73 | 765 | 391 | 0.3.0.dev0 | identical |
| r3-D-100k | D | 100k | 0 | 2026-11-14T03:35:42Z | 2.11 3.07 4.52 | 3.75 2.44 3.65 | 0 | 369.13 | 675 | 323 | 0.3.0.dev0 | identical |
| r3-A-100k | A | 100k | 0 | 2026-11-14T03:41:52Z | 3.75 2.44 3.65 | 1.77 2.08 3.27 | 0 | 196.69 | 1,191 | 1,001 | - | identical |
| r3-B-100k | B | 100k | 0 | 2026-11-14T03:45:09Z | 1.77 2.08 3.27 | 1.97 2.08 2.96 | 0 | 272.91 | 851 | 550 | 0.2.0 | identical |
| r4-D-100k | D | 100k | 0 | 2026-11-14T03:49:43Z | 1.97 2.08 2.96 | 1.68 1.91 2.59 | 0 | 375.10 | 670 | 320 | 0.3.0.dev0 | identical |
| r4-A-100k | A | 100k | 0 | 2026-11-14T03:55:59Z | 1.68 1.91 2.59 | 1.72 1.83 2.42 | 0 | 196.83 | 1,192 | 1,001 | - | identical |
| r4-B-100k | B | 100k | 0 | 2026-11-14T03:59:17Z | 1.72 1.83 2.42 | 1.54 1.67 2.20 | 0 | 267.24 | 852 | 550 | 0.2.0 | identical |
| r4-C-100k | C | 100k | 0 | 2026-11-14T04:03:45Z | 1.54 1.67 2.20 | 1.89 1.84 2.12 | 0 | 286.60 | 767 | 389 | 0.3.0.dev0 | identical |
| r5-A-100k | A | 100k | 0 | 2026-11-14T04:08:32Z | 1.89 1.84 2.12 | 1.75 1.84 2.06 | 0 | 199.54 | 1,191 | 1,001 | - | identical |
| r5-B-100k | B | 100k | 0 | 2026-11-14T04:11:53Z | 1.75 1.84 2.06 | 1.97 1.91 2.02 | 0 | 267.83 | 825 | 523 | 0.2.0 | identical |
| r5-C-100k | C | 100k | 0 | 2026-11-14T04:16:21Z | 1.97 1.91 2.02 | 1.91 1.91 1.99 | 0 | 286.30 | 766 | 391 | 0.3.0.dev0 | identical |
| r5-D-100k | D | 100k | 0 | 2026-11-14T04:21:08Z | 1.91 1.91 1.99 | 1.48 1.83 1.95 | 0 | 375.48 | 676 | 327 | 0.3.0.dev0 | identical |
| split-A-100k | A | 100k | 1 | 2026-11-14T04:27:25Z | 1.48 1.83 1.95 | 1.42 1.52 1.77 | 0 | 318.84 | 1,192 | 1,001 | - | reference |
| split-B-100k | B | 100k | 1 | 2026-11-14T04:32:46Z | 1.42 1.52 1.77 | 1.36 1.60 1.72 | 0 | 392.17 | 814 | 514 | 0.2.0 | identical |
| split-C-100k | C | 100k | 1 | 2026-11-14T04:39:22Z | 1.33 1.58 1.72 | 1.16 1.31 1.54 | 0 | 402.69 | 762 | 388 | 0.3.0.dev0 | identical |
| split-D-100k | D | 100k | 1 | 2026-11-14T04:46:09Z | 1.14 1.31 1.53 | 1.88 1.83 1.72 | 0 | 506.63 | 704 | 368 | 0.3.0.dev0 | identical |
| warmup-20k | A | 20k | 0 | 2026-11-14T04:54:40Z | 1.89 1.83 1.72 | 1.94 1.85 1.74 | 0 | 42.07 | 364 | 205 | - | reference |
| s20k-A | A | 20k | 0 | 2026-11-14T04:55:23Z | 1.94 1.85 1.74 | 2.02 1.89 1.75 | 0 | 42.48 | 365 | 205 | - | identical |
| s20k-B | B | 20k | 0 | 2026-11-14T04:56:06Z | 2.02 1.89 1.75 | 2.07 1.92 1.77 | 0 | 54.66 | 517 | 248 | 0.2.0 | identical |
| s20k-C | C | 20k | 0 | 2026-11-14T04:57:01Z | 2.07 1.92 1.77 | 2.08 1.96 1.80 | 0 | 57.63 | 509 | 177 | 0.3.0.dev0 | identical |
| s20k-D | D | 20k | 0 | 2026-11-14T04:57:59Z | 2.08 1.96 1.80 | 2.15 1.99 1.82 | 0 | 74.24 | 500 | 145 | 0.3.0.dev0 | identical |

1-minute load average over all runs: 1.1 to 9.6.

## How to quote

```
Paperless-ngx v3.4.2 document_exporter --data-only, 100,000 documents (mean 5798.1 chars of seeded text): peak RSS 1,191 MiB with the list, 825 MiB with packmem 0.2.0, JSON round trip (1.4x lower); held manifest 1,001 -> 523 MiB (1.9x lower). Median of 5 runs, manifest.json byte-identical to the list's, shared Linux server (timings indicative).
Paperless-ngx v3.4.2 document_exporter --data-only, 100,000 documents (mean 5798.1 chars of seeded text): peak RSS 1,191 MiB with the list, 766 MiB with packmem main, `default=` (1.6x lower); held manifest 1,001 -> 391 MiB (2.6x lower). Median of 5 runs, manifest.json byte-identical to the list's, shared Linux server (timings indicative).
Paperless-ngx v3.4.2 document_exporter --data-only, 100,000 documents (mean 5798.1 chars of seeded text): peak RSS 1,191 MiB with the list, 673 MiB with packmem main, `default=`, `hint="compact"` (1.8x lower); held manifest 1,001 -> 322 MiB (3.1x lower). Median of 5 runs, manifest.json byte-identical to the list's, shared Linux server (timings indicative).
```

Say "seeded synthetic data" (Gutenberg text with log-normal lengths), not real user archives. The figure is the exporter process alone; the Paperless web and worker processes are not included.
