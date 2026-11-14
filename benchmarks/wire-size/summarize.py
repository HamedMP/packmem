"""Markdown tables from results/sizes.jsonl. usage: summarize.py results/sizes.jsonl > results/tables.md"""
import json, sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1])]
by = {(r["dataset"], r["rows"], r["mode"]): r for r in rows}
datasets = ["flights", "chat", "issues", "traces", "logs"]
sizes = sorted({r["rows"] for r in rows})
CATS = ["header", "names", "chunk metadata", "length prefixes", "padding", "string offsets", "string bytes",
        "FSST symbol tables", "codes and integers", "floats", "bitmaps", "list offsets", "list shapes", "other"]


def cat(key):
    ctx, kind = key.split("/")
    if kind == "len":
        return "length prefixes"
    if kind == "pad":
        return "padding"
    return {
        "table.header": "header", "col.name": "names", "list.field_name": "names",
        "chunk.meta": "chunk metadata", "list.meta": "chunk metadata", "str.meta": "chunk metadata",
        "str.offsets": "string offsets", "str.bytes": "string bytes", "str.fsst_table": "FSST symbol tables",
        "str.codes": "codes and integers", "ints": "codes and integers", "decimals": "codes and integers",
        "mixed": "codes and integers", "floats": "floats", "bitmaps": "bitmaps", "list.offsets": "list offsets",
        "list.shapes": "list shapes",
    }.get(ctx, "other")


def cats(r):
    out = defaultdict(int)
    for k, v in r["sections"].items():
        out[cat(k)] += v
    return out


def pct(a, b):
    return f"{(a - b) / b * 100:+.0f}%"


def fmt(n):
    return f"{n:,}"


p = print
p("### packmem bytes against JSON (as written today)\n")
p("| dataset | rows | JSON | packmem | vs JSON | JSON br11 | packmem br11 | vs JSON | JSON br5 | packmem br5 | vs JSON |")
p("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for d in datasets:
    for n in sizes:
        r = by.get((d, n, "as_is"))
        if not r:
            continue
        p(f"| {d} | {fmt(n)} | {fmt(r['json_bytes'])} | {fmt(r['bytes'])} | {pct(r['bytes'], r['json_bytes'])} | "
          f"{fmt(r['json_br11'])} | {fmt(r['br11'])} | {pct(r['br11'], r['json_br11'])} | "
          f"{fmt(r['json_br5'])} | {fmt(r['br5'])} | {pct(r['br5'], r['json_br5'])} |")

p("\n### Where the bytes go (as written today), bytes per section\n")
for n in [s for s in sizes if s <= 1000]:
    p(f"\n{fmt(n)} rows:\n")
    p("| section | " + " | ".join(datasets) + " |")
    p("| --- | " + " | ".join("---:" for _ in datasets) + " |")
    cs = {d: cats(by[(d, n, "as_is")]) for d in datasets if (d, n, "as_is") in by}
    tot = {d: by[(d, n, "as_is")]["bytes"] for d in cs}
    for c in CATS:
        if not any(cs[d].get(c) for d in cs):
            continue
        p(f"| {c} | " + " | ".join(f"{fmt(cs[d].get(c, 0))} ({cs[d].get(c, 0) / tot[d] * 100:.0f}%)" if d in cs else "" for d in datasets) + " |")
    p("| **total** | " + " | ".join(fmt(tot[d]) if d in tot else "" for d in datasets) + " |")

MODES = ["fsst_used", "varint_lengths", "no_padding", "varint_headers", "all_but_fsst", "all"]
for metric, label in [("bytes", "raw"), ("br5", "Brotli 5"), ("br11", "Brotli 11")]:
    p(f"\n### Variants against today's form, {label}\n")
    p("| dataset | rows | today | " + " | ".join(MODES) + " |")
    p("| --- | ---: | ---: | " + " | ".join("---:" for _ in MODES) + " |")
    for d in datasets:
        for n in sizes:
            base = by.get((d, n, "as_is"))
            if not base or base[metric] is None:
                continue
            cells = []
            for m in MODES:
                v = by[(d, n, m)][metric]
                cells.append("" if v is None else f"{fmt(v)} ({pct(v, base[metric])})")
            p(f"| {d} | {fmt(n)} | {fmt(base[metric])} | " + " | ".join(cells) + " |")
