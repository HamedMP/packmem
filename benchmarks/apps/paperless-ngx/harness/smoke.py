"""Check the patched exporter's manifest helpers without a database.

Pulls PACKMEM_MODE, new_document_manifest, extend_document_manifest and probe out
of the patched document_exporter.py, feeds them records shaped like Django's
python serializer output (aware datetimes, dates, m2m lists, None, long text in
ASCII / Latin-1 / UCS-2 / UCS-4), consumes them the way dump() does (zip in
lockstep, add the export file names, write with the sinks' _dumps) and checks
the bytes against the plain list.

    PYTHONPATH=<packmem dir> python smoke.py <document_exporter.py> <mode>...
"""

import ast
import datetime
import gc
import hashlib
import io
import json
import os
import random
import sys
from pathlib import Path
from typing import Any
from typing import Final

from django.core.serializers.json import DjangoJSONEncoder

HELPERS = ("PACKMEM_MODE", "new_document_manifest", "extend_document_manifest", "probe")


class CommandError(Exception):
    pass


def load_helpers(path: str, mode: str) -> dict:
    tree = ast.parse(Path(path).read_text())
    keep = [
        n
        for n in tree.body
        if (isinstance(n, ast.FunctionDef) and n.name in HELPERS)
        or (isinstance(n, ast.AnnAssign) and getattr(n.target, "id", None) in HELPERS)
    ]
    assert len(keep) == len(HELPERS), [getattr(n, "name", None) for n in keep]
    os.environ["PACKMEM_MODE"] = mode
    ns = {
        "Any": Any, "Final": Final, "os": os, "sys": sys, "gc": gc, "json": json,
        "Path": Path, "CommandError": CommandError, "DjangoJSONEncoder": DjangoJSONEncoder,
    }
    exec(compile(ast.Module(body=keep, type_ignores=[]), path, "exec"), ns)
    return ns


def dumps(content):
    # documents/export/sinks.py:_dumps
    return json.dumps(content, cls=DjangoJSONEncoder, indent=2, ensure_ascii=False)


def records(n: int, seed: int = 7) -> list[dict]:
    rnd = random.Random(seed)
    utc = datetime.UTC
    texts = [
        "",
        "plain ascii invoice text\nline two\ttabbed",
        "Grüße aus Köln, Straße 5, Maß und Öl",
        "“Curly quotes” and ‘single’ ones — and a dash",
        "emoji 📄 beyond the BMP 𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
        'escapes " \\ / \b \f \r \x01 \x1f    ',
        "x" * 200_000,
        "Ünïcödé " * 5000 + "“end”",
    ]
    out = []
    for i in range(n):
        added = datetime.datetime(2020, 1, 1, tzinfo=utc) + datetime.timedelta(
            seconds=rnd.randrange(10**8), microseconds=rnd.randrange(10**6) if i % 3 else 0
        )
        out.append(
            {
                "model": "documents.document",
                "pk": i + 1,
                "fields": {
                    "owner": None if i % 4 else 3,
                    "deleted_at": None,
                    "restored_at": None,
                    "transaction_id": None,
                    "correspondent": rnd.choice([None, 1, 2, 3]),
                    "storage_path": None,
                    "title": f"Doc {i} {texts[i % len(texts)][:20]}",
                    "document_type": rnd.choice([None, 1, 2]),
                    "content": texts[i % len(texts)] + f" #{i}",
                    "mime_type": "application/pdf",
                    "checksum": hashlib.md5(f"doc-{i}".encode()).hexdigest(),
                    "archive_checksum": None,
                    "page_count": 1 + i % 9,
                    "created": datetime.date(2015, 1, 1) + datetime.timedelta(days=i * 3),
                    "modified": added + datetime.timedelta(days=1),
                    "added": added,
                    "filename": f"{i:07d}.pdf",
                    "archive_filename": None,
                    "original_filename": f"scan_{i:06d}.pdf",
                    "archive_serial_number": i if i % 3 == 0 else None,
                    "root_document": None,
                    "version_index": None,
                    "version_label": None,
                    "tags": sorted(rnd.sample(range(1, 40), i % 5)),
                },
            }
        )
    return out


def export(mode: str, exporter: str, recs: list[dict], batch_size: int) -> bytes:
    ns = load_helpers(exporter, mode)
    manifest = ns["new_document_manifest"]()
    for start in range(0, len(recs), batch_size):
        # dump() hands over freshly serialized batches; copy so arms share nothing
        batch = [{**r, "fields": dict(r["fields"])} for r in recs[start : start + batch_size]]
        ns["extend_document_manifest"](manifest, batch)
    if Path("/proc/self/status").exists():
        ns["probe"]("held", manifest)
    assert len(manifest) == len(recs)
    handle = io.StringIO()
    handle.write("[")
    first = True
    for document_dict, pk in zip(manifest, (r["pk"] for r in recs), strict=True):
        assert document_dict["pk"] == pk
        document_dict["__exported_file_name__"] = f"{pk:07d}.pdf"
        document_dict["__exported_thumbnail_name__"] = f"{pk:07d}-thumbnail.webp"
        handle.write(("" if first else ",\n") + dumps(document_dict))
        first = False
    handle.write("\n]")
    return handle.getvalue().encode()


def main() -> None:
    exporter, modes = sys.argv[1], sys.argv[2:]
    recs = records(203)
    want = export("off", exporter, recs, 50)
    print(f"off: {len(want)} bytes sha256={hashlib.sha256(want).hexdigest()[:16]}")
    failed = False
    for mode in modes:
        got = export(mode, exporter, recs, 50)
        same = got == want
        parsed = json.loads(got) == json.loads(want)
        print(f"{mode}: {len(got)} bytes sha256={hashlib.sha256(got).hexdigest()[:16]} byte-identical={same} parsed-equal={parsed}")
        failed |= not same
    if "c" in modes or "d" in modes:
        ns = load_helpers(exporter, "c")
        try:
            ns["new_document_manifest"]().extend(recs[:1])
        except TypeError:
            print("c: extend without default= rejects datetimes, as expected")
        else:
            failed = True
            print("c: extend without default= accepted datetimes (unexpected)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
