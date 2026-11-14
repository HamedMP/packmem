"""Write RESULT.md from a (scrubbed) results directory.

    python3 summarize.py <results dir> > RESULT.md
"""

import csv
import json
import statistics
import sys
from pathlib import Path

ARMS = {
    "A": "list (unmodified)",
    "B": "packmem 0.2.0, JSON round trip",
    "C": "packmem main, `default=`",
    "D": "packmem main, `default=`, `hint=\"compact\"`",
}


def mib(kb) -> float:
    return int(kb) / 1024


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def read(p: Path) -> str:
    return p.read_text().strip() if p.exists() else "(missing)"


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def fmt(x, nd=0, unit=""):
    return "-" if x is None else f"{x:,.{nd}f}{unit}"


def output_note(rs, arm) -> str:
    vs = {r["vs_ref"] for r in rs if r["arm"] == arm}
    if vs == {"identical"}:
        return "manifest.json byte-identical to the list's"
    if vs <= {"identical", "parsed-equal"}:
        return "manifest.json parses equal to the list's (bytes differ, see compare logs)"
    return "manifest.json DIFFERS from the list's: " + ", ".join(sorted(vs))


def main() -> None:
    res = Path(sys.argv[1])
    rows = list(csv.DictReader((res / "runs.tsv").open(), delimiter="\t"))
    for r in rows:
        r["maxrss"] = mib(r["maxrss_kb"]) if r["maxrss_kb"] else None
        s, h = num(r["start_rss_kb"]), num(r["held_rss_kb"])
        r["held"] = (h - s) / 1024 if s is not None and h is not None else None
        r["wall"] = num(r["wall_s"])
        r["nb"] = num(r["table_nbytes"])
    ok = [r for r in rows if r["exit"] == "0"]
    main_runs = [r for r in ok if r["scale"] == "100k" and r["split"] == "0" and r["round"] != "0"]
    seed = {k: json.loads((res / f"seed-{k}.json").read_text()) for k in ("100k", "20k") if (res / f"seed-{k}.json").exists()}
    out = []
    w = out.append

    def arm_stats(rs, arm):
        a = [r for r in rs if r["arm"] == arm]
        return a, med([r["maxrss"] for r in a]), med([r["held"] for r in a]), med([r["wall"] for r in a])

    base = {}
    for scale, split, sel in (("100k", "0", main_runs),):
        _, base_rss, base_held, _ = arm_stats(sel, "A")
        base = {"rss": base_rss, "held": base_held}

    w("# Paperless-ngx `document_exporter`: document manifest as a list vs packmem.Table\n")
    if base.get("rss"):
        parts = []
        for arm in "BCD":
            _, rss, held, _ = arm_stats(main_runs, arm)
            if rss:
                parts.append(f"{arm} {fmt(rss)} MiB ({base['rss'] / rss:.1f}x lower)")
        w(f"**Headline (measured):** `document_exporter --data-only` on 100,000 seeded documents, peak RSS of the "
          f"exporter process (median of {len([r for r in main_runs if r['arm'] == 'A'])} runs): A (list) "
          f"{fmt(base['rss'])} MiB; " + "; ".join(parts) + ". See the tables for the manifest held in memory "
          "and for correctness.\n")
    w("MiB = 2^20 bytes. Peak RSS is `Maximum resident set size` from GNU `time -v` around "
      "`python3 manage.py document_exporter`. Held manifest is RSS after `gc.collect()` once every document is in "
      "the manifest, minus RSS after `gc.collect()` just before the first record is read (probe lines in the "
      "patched exporter).\n")

    w("## Versions and environment\n")
    for name in ("host.txt", "container.txt", "image-digests.txt", "images-pulled.txt", "packmem-0.2.0.txt",
                 "packmem-main.txt", "gnu-time.txt", "smoke-b.txt", "smoke-cd.txt"):
        w(f"**{name}**\n\n```\n{read(res / 'env' / name)}\n```\n")

    w("## Method\n")
    w("- Paperless-ngx v3.4.2, published image pinned by digest (above). Paperless's own "
      "`docker/compose/docker-compose.postgres.yml` with an override: no published port, webserver "
      "`mem_limit: 40g`, `memswap_limit: 40g`, `cpus: 4`, scheduled Celery tasks disabled, and the patched "
      "`document_exporter.py` bind-mounted read-only over the image's copy (the image's copy was checked "
      "to be byte-identical to v3.4.2 before patching). Compose project `packmem-paperless`.")
    w("- One patched exporter for all arms, selected by `PACKMEM_MODE` (`off`, `b`, `c`, `d`); packmem "
      "versions come from unpacked wheels on `PYTHONPATH` (none for A). The patch replaces "
      "`document_manifest: list[dict] = []` and its `extend`; nothing else changes. "
      "See `harness/paperless/exporter.patch`.")
    w("  - A: `document_manifest = []`, `extend(batch)`.")
    w("  - B: `packmem.Table()`, `extend(json.loads(json.dumps(batch, cls=DjangoJSONEncoder)))` (0.2.0 has no `default=`).")
    w("  - C: `packmem.Table(hint=\"balanced\")`, `extend(batch, default=DjangoJSONEncoder().default)`.")
    w("  - D: C with `hint=\"compact\"`.")
    w("- Command, run as the `paperless` user inside the webserver container: "
      "`nice -n 10 /usr/bin/time -v python3 manage.py document_exporter <dir> --data-only --no-progress-bar` "
      "(plus `--split-manifest` for the split runs; `PAPERLESS_DBNAME=paperless_20k` for 20k).")
    w(f"- Order: one warm-up export (arm A, used as the reference output), then {max(int(r['round']) for r in main_runs) if main_runs else 0} "
      "rounds of A, B, C, D with the starting arm rotated each round; then one `--split-manifest` run per arm; "
      "then a warm-up and one run per arm on the 20,000-document database.")
    w("- Correctness: sha256 of `manifest.json` (or of the sorted per-file sha256 list for `--split-manifest`) "
      "against the reference A output; any mismatch is parsed and compared field by field (`compare.py`).")
    w("- The server also runs CI; load average at the start and end of every run is listed. Memory is the "
      "result; timings are indicative.\n")

    w("## Data\n")
    if seed:
        keys = ["documents", "content_chars_total", "content_chars_mean", "content_chars_median", "content_chars_p90",
                "content_chars_p99", "content_chars_max", "content_empty", "content_utf8_bytes_total",
                "content_cpython_sizeof_total", "content_kinds", "tag_links", "data_sha256", "seconds"]
        w("| | " + " | ".join(seed) + " |\n| --- | " + " | ".join("---" for _ in seed) + " |")
        for k in keys:
            w(f"| {k} | " + " | ".join(f"{s.get(k):,}" if isinstance(s.get(k), int) else str(s.get(k)) for s in seed.values()) + " |")
        s0 = next(iter(seed.values()))
        w(f"\nSeed {s0['seed']}; log-normal content length mu={s0['lognormal']['mu']}, sigma={s0['lognormal']['sigma']}, "
          f"capped at {s0['lognormal']['cap']:,} chars; text cut from Project Gutenberg (English: pg1342, pg2701, pg84, "
          "pg1661; German: pg2229, pg22367, pg5323, pg69327, pg2407), about a third with flattened typography. "
          "25 correspondents, 12 document types, 40 tags (0-4 per document). No files (`--data-only`).\n")
        w("Corpus sha256: `" + json.dumps(s0["corpus_sha256"]) + "`\n")
    for k in ("100k", "20k"):
        w(f"Database {k}: `{read(res / f'seed-{k}.db.txt')}` (size, documents, sum of content length)\n")

    def table(title, sel, note=""):
        w(f"## {title}\n")
        if note:
            w(note + "\n")
        _, a_rss, a_held, a_wall = arm_stats(sel, "A")
        w("| Arm | Runs | Peak RSS MiB, median (min-max) | vs A | Held manifest MiB, median | vs A | Table nbytes MiB | Wall s, median (min-max) | Output vs reference |")
        w("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for arm in "ABCD":
            a, rss, held, wall = arm_stats(sel, arm)
            if not a:
                continue
            rs = [r["maxrss"] for r in a]
            ws = [r["wall"] for r in a if r["wall"] is not None]
            nb = med([r["nb"] for r in a])
            vs = sorted({r["vs_ref"] for r in a})
            w(f"| {arm}: {ARMS[arm]} | {len(a)} | {fmt(rss)} ({fmt(min(rs))}-{fmt(max(rs))}) | "
              f"{'-' if arm == 'A' or not rss or not a_rss else f'{a_rss / rss:.2f}x lower'} | {fmt(held)} | "
              f"{'-' if arm == 'A' or not held or not a_held or held <= 0 else f'{a_held / held:.1f}x lower'} | "
              f"{fmt(nb / 2**20 if nb else None, 1)} | {fmt(wall, 1)} ({fmt(min(ws) if ws else None, 1)}-{fmt(max(ws) if ws else None, 1)}) | {', '.join(vs)} |")
        w("")

    table("100,000 documents, manifest.json", main_runs)
    table("100,000 documents, --split-manifest (1 run per arm)",
          [r for r in ok if r["scale"] == "100k" and r["split"] == "1"])
    s20 = [r for r in ok if r["scale"] == "20k" and r["round"] != "0"]
    table("20,000 documents, manifest.json (1 run per arm)", s20)

    if main_runs and s20:
        w("## Scaling 20k -> 100k\n")
        w("| Arm | Held MiB at 20k | Held MiB at 100k | Ratio | Peak RSS MiB at 20k | at 100k |")
        w("| --- | --- | --- | --- | --- | --- |")
        for arm in "ABCD":
            _, r20, h20, _ = arm_stats(s20, arm)
            _, r100, h100, _ = arm_stats(main_runs, arm)
            ratio = f"{h100 / h20:.2f}" if h20 and h100 and h20 > 0 else "-"
            w(f"| {arm} | {fmt(h20)} | {fmt(h100)} | {ratio} | {fmt(r20)} | {fmt(r100)} |")
        w("")

    w("## Every run\n")
    w("| Label | Arm | Scale | Split | Start (UTC) | Load start | Load end | Exit | Wall s | Peak RSS MiB | Held MiB | packmem | Output |")
    w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        w(f"| {r['label']} | {r['arm']} | {r['scale']} | {r['split']} | {r['start_utc']} | {r['load_start']} | "
          f"{r['load_end']} | {r['exit']} | {r['wall_s']} | {fmt(r['maxrss'])} | {fmt(r['held'])} | {r['packmem']} | {r['vs_ref']} |")
    loads = [float(x.split()[0]) for r in rows for x in (r["load_start"], r["load_end"]) if x]
    if loads:
        w(f"\n1-minute load average over all runs: {min(loads):.1f} to {max(loads):.1f}.\n")
    bad = [r for r in rows if r["vs_ref"] in ("DIFFERENT", "failed") or r["exit"] != "0"]
    if bad:
        w("**Runs that failed or differ:** " + ", ".join(r["label"] for r in bad) + " (see `logs/<label>.log` and `logs/<label>.compare.txt`).\n")

    w("## How to quote\n")
    w("```")
    if base.get("rss"):
        for arm in "BCD":
            _, rss, held, _ = arm_stats(main_runs, arm)
            if rss and held and base.get("held"):
                w(f"Paperless-ngx v3.4.2 document_exporter --data-only, 100,000 documents (mean {seed.get('100k', {}).get('content_chars_mean', '?')} chars of seeded text): "
                  f"peak RSS {fmt(base['rss'])} MiB with the list, {fmt(rss)} MiB with {ARMS[arm]} "
                  f"({base['rss'] / rss:.1f}x lower); held manifest {fmt(base['held'])} -> {fmt(held)} MiB "
                  f"({base['held'] / held:.1f}x lower). Median of {len([r for r in main_runs if r['arm'] == arm])} runs, "
                  f"{output_note(main_runs, arm)}, shared Linux server (timings indicative).")
    w("```")
    w("\nSay \"seeded synthetic data\" (Gutenberg text with log-normal lengths), not real user archives. "
      "The figure is the exporter process alone; the Paperless web and worker processes are not included.")
    print("\n".join(out))


if __name__ == "__main__":
    main()
