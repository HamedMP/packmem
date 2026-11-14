"""Seed a Paperless database with synthetic documents for the exporter benchmark.

Content is cut from Project Gutenberg texts (English and German) with log-normal
lengths (median ~2,000 chars, mean ~6,000, capped at 200,000). About a third of
the documents get their typography flattened, so the set mixes the CPython
string layouts real OCR text produces: pure ASCII, Latin-1 (umlauts) and UCS-2
(curly quotes, dashes). Every document is generated from Random(f"{seed}:{i}"),
so N=20,000 is exactly the first 20,000 documents of N=100,000.

Run inside the webserver container, from /usr/src/paperless/src:
    python3 seed.py --n 100000 --seed 20261114 --corpus /harness/corpus [--dry-run]
Prints one JSON object with the data's statistics on stdout.
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import random
import sys
import time
from pathlib import Path

GERMAN = ("pg2229.txt", "pg22367.txt", "pg5323.txt", "pg69327.txt", "pg2407.txt")
ENGLISH = ("pg1342.txt", "pg2701.txt", "pg84.txt", "pg1661.txt")
MEDIAN, MEAN, CAP = 2000, 6000, 200_000
SIGMA = math.sqrt(2 * math.log(MEAN / MEDIAN))
MU = math.log(MEDIAN)
FLATTEN = str.maketrans(
    {
        "“": '"', "”": '"', "„": '"', "‟": '"', "«": '"', "»": '"',
        "‘": "'", "’": "'", "‚": "'", "—": "-", "–": "-", "…": "...", "\xa0": " ",
    },
)
MIME = (("application/pdf", ".pdf", 85), ("image/jpeg", ".jpg", 10), ("text/plain", ".txt", 5))
N_CORRESPONDENTS, N_TYPES, N_TAGS = 25, 12, 40
EPOCH = datetime.datetime(2015, 1, 1, tzinfo=datetime.UTC)


def body(path: Path) -> str:
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    start = text.index("\n", text.index("*** START OF")) + 1
    return text[start : text.index("*** END OF")].strip()


def load_corpus(corpus: Path) -> tuple[dict[str, str], dict[str, str]]:
    sums = {
        name: hashlib.sha256((corpus / name).read_bytes()).hexdigest()
        for name in GERMAN + ENGLISH
    }
    texts = {
        "de": "\n\n".join(body(corpus / n) for n in GERMAN),
        "en": "\n\n".join(body(corpus / n) for n in ENGLISH),
    }
    return texts, sums


def kind(s: str) -> str:
    m = max(map(ord, s), default=0)
    return "ascii" if m < 128 else "latin1" if m < 256 else "ucs2" if m < 65536 else "ucs4"


def make_document(i: int, seed: int, texts: dict[str, str]) -> dict:
    rnd = random.Random(f"{seed}:{i}")
    lang = "de" if rnd.random() < 0.45 else "en"
    src = texts[lang]
    if rnd.random() < 0.01:
        content = ""
    else:
        n = max(1, min(CAP, int(rnd.lognormvariate(MU, SIGMA))))
        start = rnd.randrange(len(src) - n)
        space = src.find(" ", start, start + 40)
        start = space + 1 if space >= 0 else start
        content = src[start : start + n]
    if rnd.random() < 0.35:
        content = content.translate(FLATTEN)
        if lang == "en":
            content = content.encode("ascii", "ignore").decode()
    mime, ext, _ = rnd.choices(MIME, weights=[w for *_, w in MIME])[0]
    added = EPOCH + datetime.timedelta(
        seconds=rnd.randrange(11 * 365 * 86400),
        microseconds=rnd.randrange(1_000_000),
    )
    created = (added - datetime.timedelta(days=rnd.randrange(60))).date()
    words = content.split()[:6]
    return {
        "pk": i + 1,
        "title": (" ".join(words) or f"Document {i + 1}")[:128],
        "content": content,
        "mime_type": mime,
        "checksum": hashlib.md5(f"packmem-paperless-{seed}-{i}".encode()).hexdigest(),
        "page_count": 1 + len(content) // 3000,
        "created": created,
        "added": added,
        "modified": added + datetime.timedelta(hours=rnd.randrange(1, 2000)),
        "filename": f"{i + 1:07d}{ext}",
        "original_filename": f"scan_{i + 1:07d}{ext}",
        "archive_serial_number": i + 1 if rnd.random() < 0.3 else None,
        "correspondent_id": rnd.choice([None, *range(1, N_CORRESPONDENTS + 1)]),
        "document_type_id": rnd.choice([None, *range(1, N_TYPES + 1)]),
        "tags": sorted(rnd.sample(range(1, N_TAGS + 1), rnd.choice([0, 1, 1, 2, 2, 3, 4]))),
    }


class Stats:
    def __init__(self) -> None:
        self.lengths: list[int] = []
        self.utf8 = 0
        self.sizeof = 0
        self.kinds: dict[str, int] = {}
        self.tags = 0
        self.digest = hashlib.sha256()

    def add(self, doc: dict) -> None:
        c = doc["content"]
        self.lengths.append(len(c))
        b = c.encode()
        self.utf8 += len(b)
        self.sizeof += sys.getsizeof(c)
        k = kind(c)
        self.kinds[k] = self.kinds.get(k, 0) + 1
        self.tags += len(doc["tags"])
        self.digest.update(
            json.dumps({k: v for k, v in doc.items() if k != "content"}, default=str).encode(),
        )
        self.digest.update(b + b"\0")

    def summary(self) -> dict:
        s = sorted(self.lengths)
        n = len(s)

        def q(p: float) -> int:
            return s[min(n - 1, int(p * n))]

        return {
            "documents": n,
            "content_chars_total": sum(s),
            "content_chars_mean": round(sum(s) / n, 1),
            "content_chars_median": q(0.5),
            "content_chars_p90": q(0.9),
            "content_chars_p99": q(0.99),
            "content_chars_max": s[-1],
            "content_empty": sum(1 for x in s if x == 0),
            "content_utf8_bytes_total": self.utf8,
            "content_cpython_sizeof_total": self.sizeof,
            "content_kinds": dict(sorted(self.kinds.items())),
            "tag_links": self.tags,
            "data_sha256": self.digest.hexdigest(),
        }


def seed_database(docs, n: int) -> None:
    from django.db import connection
    from django.db import transaction

    from documents.models import Correspondent
    from documents.models import Document
    from documents.models import DocumentType
    from documents.models import Tag

    if Document.global_objects.exists():
        raise SystemExit("database already has documents; seed a fresh database")
    with transaction.atomic():
        for k in range(1, N_CORRESPONDENTS + 1):
            Correspondent.objects.create(pk=k, name=f"Correspondent {k:02d}")
        for k in range(1, N_TYPES + 1):
            DocumentType.objects.create(pk=k, name=f"Type {k:02d}")
        for k in range(1, N_TAGS + 1):
            Tag.objects.create(pk=k, name=f"tag-{k:02d}", color=f"#{(k * 2654435761) % 0xFFFFFF:06x}")
    through = Document.tags.through
    batch: list[dict] = []

    def flush() -> None:
        with transaction.atomic():
            Document.global_objects.bulk_create(
                [Document(**{k: v for k, v in d.items() if k not in ("tags", "modified")}) for d in batch],
            )
            through.objects.bulk_create(
                [through(document_id=d["pk"], tag_id=t) for d in batch for t in d["tags"]],
            )
            # bulk_create sets the auto_now field to now; give it the generated value
            with connection.cursor() as cur:
                cur.executemany(
                    "UPDATE documents_document SET modified = %s WHERE id = %s",
                    [(d["modified"], d["pk"]) for d in batch],
                )
        batch.clear()

    t0 = time.monotonic()
    for d in docs:
        batch.append(d)
        if len(batch) == 1000:
            flush()
            if d["pk"] % 10000 == 0:
                print(f"seeded {d['pk']}/{n} in {time.monotonic() - t0:.0f} s", file=sys.stderr, flush=True)
    if batch:
        flush()
    with connection.cursor() as cur:
        for model in (Correspondent, DocumentType, Tag, Document):
            table = model._meta.db_table
            cur.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), (SELECT MAX(id) FROM {table}))")
        cur.execute("ANALYZE")
    assert Document.global_objects.count() == n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, required=True)
    ap.add_argument("--seed", type=int, default=20261114)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--dry-run", action="store_true", help="generate and report stats, no database")
    args = ap.parse_args()

    texts, sums = load_corpus(args.corpus)
    stats = Stats()

    def docs():
        for i in range(args.n):
            d = make_document(i, args.seed, texts)
            stats.add(d)
            yield d

    t0 = time.monotonic()
    if args.dry_run:
        for _ in docs():
            pass
    else:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "paperless.settings")
        import django

        django.setup()
        seed_database(docs(), args.n)
    out = {
        "seed": args.seed,
        "dbname": os.environ.get("PAPERLESS_DBNAME", "paperless"),
        "dry_run": args.dry_run,
        "seconds": round(time.monotonic() - t0, 1),
        "lognormal": {"mu": round(MU, 4), "sigma": round(SIGMA, 4), "cap": CAP},
        "corpus_chars": {k: len(v) for k, v in texts.items()},
        "corpus_sha256": sums,
        **stats.summary(),
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
