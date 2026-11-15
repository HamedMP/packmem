# Paperless-ngx `document_exporter`: document manifest as a list vs packmem.Table

**Headline (measured):** `document_exporter --data-only` on 100,000 seeded documents, peak RSS of the exporter process (median of 5 runs): A (list) 1,191 MiB; B 664 MiB (1.8x lower); C 660 MiB (1.8x lower); D 580 MiB (2.1x lower). See the tables for the manifest held in memory and for correctness.

MiB = 2^20 bytes. Peak RSS is `Maximum resident set size` from GNU `time -v` around `python3 manage.py document_exporter`. Held manifest is RSS after `gc.collect()` once every document is in the manifest, minus RSS after `gc.collect()` just before the first record is read (probe lines in the patched exporter).

## Versions and environment

**host.txt**

```
date: 2026-11-15T13:34:18Z
kernel: Linux 6.8.0-139-generic x86_64
host glibc: ldd (Ubuntu GLIBC 2.39-0ubuntu8.12) 2.39
cpus: 32
mem: 124 GB
docker: 29.1.3
compose: 2.40.3+ds1-0ubuntu1~24.04.1
loadavg: 2.45 3.99 7.95
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
ghcr.io/paperless-ngx/paperless-ngx:3.4.2@sha256:d704e84f88300eb6ab001ab15720a2330ff99169cf9f94d6b8fcc44b63a84c84 ghcr.io/paperless-ngx/paperless-ngx@sha256:d704e84f88300eb6ab001ab15720a2330ff99169cf9f94d6b8fcc44b63a84c84
docker.io/valkey/valkey:9-alpine valkey/valkey@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b
docker.io/library/postgres:18 postgres@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc
```

**images-pulled.txt**

```
ghcr.io/paperless-ngx/paperless-ngx:<none>@d704e84f8830
postgres:18@2ea8630df176
```

**packmem-0.2.0.txt**

```
packmem 0.2.0: packmem-0.2.0-cp310-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl sha256=09c5ba04ee380af34600af1c9d6fac3f3a0337ebeb19f75292eb6423633614c7
```

**packmem-main.txt**

```
(missing)
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
(missing)
```

## Method

- Paperless-ngx v3.4.2, published image pinned by digest (above). Paperless's own `docker/compose/docker-compose.postgres.yml` with an override: no published port, webserver `mem_limit: 40g`, `memswap_limit: 40g`, `cpus: 4`, scheduled Celery tasks disabled, and the patched `document_exporter.py` bind-mounted read-only over the image's copy (the image's copy was checked to be byte-identical to v3.4.2 before patching). Compose project `packmem-paperless`.
- One patched exporter for all arms, selected by `PACKMEM_MODE` (`off`, `b`, `c`, `d`); packmem versions come from unpacked wheels on `PYTHONPATH` (none for A). The patch replaces `document_manifest: list[dict] = []` and its `extend`; nothing else changes. See `harness/paperless/exporter.patch`.
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
| seconds | 62.9 | 13.8 |

Seed 20261114; log-normal content length mu=7.6009, sigma=1.4823, capped at 200,000 chars; text cut from Project Gutenberg (English: pg1342, pg2701, pg84, pg1661; German: pg2229, pg22367, pg5323, pg69327, pg2407), about a third with flattened typography. 25 correspondents, 12 document types, 40 tags (0-4 per document). No files (`--data-only`).

Corpus sha256: `{"pg2229.txt": "fed2a58edd6910ee96d27ada614d34bcc41f03750d86541c41246bb74c564ff7", "pg22367.txt": "359d3f5983c812393f4bd7ee49a350ffffc7d476015e58d6b84b6c848dd2b0e9", "pg5323.txt": "fc2cc841038004b845426452f808e6537045604d66d2878c7007a8909e9240df", "pg69327.txt": "0254e2e361fca684887374ed3e4e4c32f03ac5b7022f54e9a128d1bff6b35b80", "pg2407.txt": "3642f9c98c1bbca55adf25296f4f623bda69c6d47cff46ed5f423053816a19c4", "pg1342.txt": "3f6bb9d6f78e0293b56acd4714dd68cb7d6d1d293402031ce9d5a216bcaf9d75", "pg2701.txt": "b5e88b71a1cda068e9ab1d94344c9d932338ba6da1a66def97a1aecd9cfcc87d", "pg84.txt": "2b97b7f8aad508649481d8dd4f6b54f9b965ddb3ba634e9151c815f537b49e42", "pg1661.txt": "922e2a12ccb43a4c9544c260b2166c6ad2097aeb5957faeee113f173bb857cd0"}`

Database 100k: `579 MB|100000|579805732` (size, documents, sum of content length)

Database 20k: `132 MB|20000|118192366` (size, documents, sum of content length)

## 100,000 documents, manifest.json

| Arm | Runs | Peak RSS MiB, median (min-max) | vs A | Held manifest MiB, median | vs A | Table nbytes MiB | Wall s, median (min-max) | Output vs reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: list (unmodified) | 5 | 1,191 (1,188-1,192) | - | 1,001 | - | - | 196.3 (192.3-291.4) | identical |
| B: packmem 0.3.2, JSON round trip | 5 | 664 (662-676) | 1.79x lower | 388 | 2.6x lower | 328.7 | 277.0 (275.9-393.4) | identical |
| C: packmem 0.3.2, `default=` | 5 | 660 (659-679) | 1.80x lower | 383 | 2.6x lower | 328.7 | 277.1 (273.3-301.2) | identical |
| D: packmem 0.3.2, `default=`, `hint="compact"` | 5 | 580 (562-606) | 2.05x lower | 301 | 3.3x lower | 229.4 | 399.7 (396.8-512.0) | identical |

## 100,000 documents, --split-manifest (1 run per arm)

| Arm | Runs | Peak RSS MiB, median (min-max) | vs A | Held manifest MiB, median | vs A | Table nbytes MiB | Wall s, median (min-max) | Output vs reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## 20,000 documents, manifest.json (1 run per arm)

| Arm | Runs | Peak RSS MiB, median (min-max) | vs A | Held manifest MiB, median | vs A | Table nbytes MiB | Wall s, median (min-max) | Output vs reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: list (unmodified) | 1 | 364 (364-364) | - | 205 | - | - | 39.6 (39.6-39.6) | identical |
| B: packmem 0.3.2, JSON round trip | 1 | 403 (403-403) | 0.90x lower | 151 | 1.4x lower | 67.7 | 56.2 (56.2-56.2) | identical |
| C: packmem 0.3.2, `default=` | 1 | 395 (395-395) | 0.92x lower | 144 | 1.4x lower | 67.7 | 56.1 (56.1-56.1) | identical |
| D: packmem 0.3.2, `default=`, `hint="compact"` | 1 | 379 (379-379) | 0.96x lower | 129 | 1.6x lower | 46.9 | 79.9 (79.9-79.9) | identical |

## Scaling 20k -> 100k

| Arm | Held MiB at 20k | Held MiB at 100k | Ratio | Peak RSS MiB at 20k | at 100k |
| --- | --- | --- | --- | --- | --- |
| A | 205 | 1,001 | 4.88 | 364 | 1,191 |
| B | 151 | 388 | 2.58 | 403 | 664 |
| C | 144 | 383 | 2.65 | 395 | 660 |
| D | 129 | 301 | 2.34 | 379 | 580 |

## Every run

| Label | Arm | Scale | Split | Start (UTC) | Load start | Load end | Exit | Wall s | Peak RSS MiB | Held MiB | packmem | Output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| warmup-100k | A | 100k | 0 | 2026-11-15T13:36:39Z | 1.37 2.95 7.00 | 1.03 2.02 5.86 | 0 | 192.91 | 1,192 | 1,001 | - | reference |
| r1-A-100k | A | 100k | 0 | 2026-11-15T13:39:52Z | 1.03 2.02 5.86 | 1.13 1.67 4.99 | 0 | 196.27 | 1,191 | 1,001 | - | identical |
| r1-B-100k | B | 100k | 0 | 2026-11-15T13:43:10Z | 1.13 1.67 4.99 | 1.15 1.32 3.97 | 0 | 277.02 | 666 | 390 | 0.3.2 | identical |
| r1-C-100k | C | 100k | 0 | 2026-11-15T13:47:47Z | 1.15 1.32 3.97 | 1.08 1.18 3.22 | 0 | 277.25 | 675 | 397 | 0.3.2 | identical |
| r1-D-100k | D | 100k | 0 | 2026-11-15T13:52:26Z | 1.07 1.17 3.21 | 1.14 1.15 2.48 | 0 | 399.31 | 581 | 353 | 0.3.2 | identical |
| r2-B-100k | B | 100k | 0 | 2026-11-15T13:59:06Z | 1.13 1.15 2.47 | 1.24 1.13 2.11 | 0 | 276.11 | 663 | 385 | 0.3.2 | identical |
| r2-C-100k | C | 100k | 0 | 2026-11-15T14:03:43Z | 1.24 1.13 2.11 | 1.24 1.16 1.86 | 0 | 273.54 | 660 | 382 | 0.3.2 | identical |
| r2-D-100k | D | 100k | 0 | 2026-11-15T14:08:17Z | 1.24 1.16 1.86 | 1.14 1.12 1.59 | 0 | 396.76 | 580 | 318 | 0.3.2 | identical |
| r2-A-100k | A | 100k | 0 | 2026-11-15T14:14:55Z | 1.14 1.12 1.59 | 1.41 1.21 1.53 | 0 | 192.68 | 1,191 | 1,001 | - | identical |
| r3-C-100k | C | 100k | 0 | 2026-11-15T14:18:08Z | 1.41 1.21 1.53 | 1.23 1.32 1.50 | 0 | 277.13 | 660 | 383 | 0.3.2 | identical |
| r3-D-100k | D | 100k | 0 | 2026-11-15T14:22:46Z | 1.23 1.32 1.50 | 1.17 1.21 1.37 | 0 | 399.66 | 562 | 301 | 0.3.2 | identical |
| r3-A-100k | A | 100k | 0 | 2026-11-15T14:29:27Z | 1.17 1.21 1.37 | 1.16 1.17 1.33 | 0 | 192.29 | 1,192 | 1,001 | - | identical |
| r3-B-100k | B | 100k | 0 | 2026-11-15T14:32:40Z | 1.16 1.17 1.33 | 1.23 1.17 1.27 | 0 | 275.88 | 676 | 398 | 0.3.2 | identical |
| r4-D-100k | D | 100k | 0 | 2026-11-15T14:37:17Z | 1.23 1.17 1.27 | 21.27 14.71 6.97 | 0 | 477.07 | 562 | 301 | 0.3.2 | identical |
| r4-A-100k | A | 100k | 0 | 2026-11-15T14:55:15Z | 24.11 27.72 17.83 | 19.34 23.09 18.38 | 0 | 281.62 | 1,188 | 1,001 | - | identical |
| r4-B-100k | B | 100k | 0 | 2026-11-15T15:03:27Z | 3.56 13.27 15.40 | 3.20 7.01 12.10 | 0 | 296.41 | 662 | 386 | 0.3.2 | identical |
| r4-C-100k | C | 100k | 0 | 2026-11-15T15:08:25Z | 3.20 7.01 12.10 | 5.38 5.54 10.00 | 0 | 301.23 | 679 | 404 | 0.3.2 | identical |
| r5-A-100k | A | 100k | 0 | 2026-11-15T15:23:27Z | 29.00 23.35 17.31 | 21.83 23.21 19.07 | 0 | 291.44 | 1,190 | 1,001 | - | identical |
| r5-B-100k | B | 100k | 0 | 2026-11-15T15:38:20Z | 32.83 29.68 24.26 | 15.28 24.84 24.62 | 0 | 393.36 | 664 | 388 | 0.3.2 | identical |
| r5-C-100k | C | 100k | 0 | 2026-11-15T15:54:54Z | 3.88 9.47 16.89 | 1.12 4.41 12.82 | 0 | 273.34 | 659 | 381 | 0.3.2 | identical |
| r5-D-100k | D | 100k | 0 | 2026-11-15T15:59:28Z | 1.12 4.41 12.82 | 24.11 19.10 15.82 | 0 | 512.00 | 606 | 301 | 0.3.2 | identical |
| warmup-20k | A | 20k | 0 | 2026-11-15T16:18:02Z | 21.91 29.33 23.55 | 23.43 28.46 23.58 | 0 | 54.79 | 365 | 205 | - | reference |
| s20k-A | A | 20k | 0 | 2026-11-15T16:28:27Z | 3.51 12.63 18.66 | 2.68 11.27 17.94 | 0 | 39.57 | 364 | 205 | - | identical |
| s20k-B | B | 20k | 0 | 2026-11-15T16:29:07Z | 2.68 11.27 17.94 | 2.14 9.67 17.01 | 0 | 56.18 | 403 | 151 | 0.3.2 | identical |
| s20k-C | C | 20k | 0 | 2026-11-15T16:30:04Z | 2.14 9.67 17.01 | 1.65 8.26 16.10 | 0 | 56.07 | 395 | 144 | 0.3.2 | identical |
| s20k-D | D | 20k | 0 | 2026-11-15T16:31:01Z | 1.65 8.26 16.10 | 1.69 6.76 14.93 | 0 | 79.87 | 379 | 129 | 0.3.2 | identical |

1-minute load average over all runs: 1.0 to 32.8.

## How to quote

```
Paperless-ngx v3.4.2 document_exporter --data-only, 100,000 documents (mean 5798.1 chars of seeded text): peak RSS 1,191 MiB with the list, 664 MiB with packmem 0.3.2, JSON round trip (1.8x lower); held manifest 1,001 -> 388 MiB (2.6x lower). Median of 5 runs, manifest.json byte-identical to the list's, shared Linux server (timings indicative).
Paperless-ngx v3.4.2 document_exporter --data-only, 100,000 documents (mean 5798.1 chars of seeded text): peak RSS 1,191 MiB with the list, 660 MiB with packmem 0.3.2, `default=` (1.8x lower); held manifest 1,001 -> 383 MiB (2.6x lower). Median of 5 runs, manifest.json byte-identical to the list's, shared Linux server (timings indicative).
Paperless-ngx v3.4.2 document_exporter --data-only, 100,000 documents (mean 5798.1 chars of seeded text): peak RSS 1,191 MiB with the list, 580 MiB with packmem 0.3.2, `default=`, `hint="compact"` (2.1x lower); held manifest 1,001 -> 301 MiB (3.3x lower). Median of 5 runs, manifest.json byte-identical to the list's, shared Linux server (timings indicative).
```

Say "seeded synthetic data" (Gutenberg text with log-normal lengths), not real user archives. The figure is the exporter process alone; the Paperless web and worker processes are not included.
