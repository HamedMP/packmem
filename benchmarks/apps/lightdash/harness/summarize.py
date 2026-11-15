"""Tables for RESULT.md from run.mjs output: per-arm medians (min-max) and the load for every arm run.

usage: python3 summarize.py <runs.jsonl> [more.jsonl ...]
"""

import json
import statistics
import sys

ORDER = ["A", "P", "B", "C", "D"]
recs = [json.loads(l) for p in sys.argv[1:] for l in open(p) if l.strip()]
arms = [r for r in recs if r["kind"] == "arm"]
for r in arms:  # the smoke runs predate these two fields
    r.setdefault("held_total", r["heap_held"] + r["backing_after"] - r["backing_before"])
    r.setdefault("noisy", float(r["load_start"].split()[0]) > 4)
checks = [r for r in recs if r["kind"] == "check"]
queries = [r for r in recs if r["kind"] == "query"]


def spread(xs, fmt):
    xs = sorted(xs)
    return f"{fmt(statistics.median(xs))} ({fmt(xs[0])}-{fmt(xs[-1])})"


mb = lambda b: f"{b / 1e6:,.2f}"
ms = lambda v: f"{v:,.0f}"
s = lambda v: f"{v:,.2f}"

print(f"rounds: {len(queries)}; checks ok: {sum(c['ok'] for c in checks)}/{len(checks)}; "
      f"hashes: {sorted({h for c in checks for h in c['sha256']})}")
print(f"rows per query: {sorted({q['total'] for q in queries})}; query ready ms: {[q['readyMs'] for q in queries]}")
print()
print("| Arm | Runs | Until usable, ms | Wire MB | Requests | Server s (sum) | Held MB (heap + outside) | of which JS heap MB | WebAssembly MB | Noisy runs |")
print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
for a in ORDER:
    rs = [r for r in arms if r["arm"] == a]
    if not rs:
        continue
    print(f"| {a}: {rs[0]['label']} | {len(rs)} | {spread([r['ms'] for r in rs], ms)} | "
          f"{spread([r['wire_bytes'] for r in rs], mb)} | {rs[0]['requests']} | "
          f"{spread([r['server']['upstream_s_sum'] for r in rs], s)} | {spread([r['held_total'] for r in rs], mb)} | "
          f"{spread([r['heap_held'] for r in rs], mb)} | {spread([r['wasm_memory_bytes'] for r in rs], mb)} | "
          f"{sum(r['noisy'] for r in rs)} |")
print()
print("| Run | Arm | Load at start (1, 5, 15 min) | Load at end | Noisy | Until usable, ms |")
print("| --- | --- | --- | --- | --- | ---: |")
for r in arms:
    print(f"| {r['run']} | {r['arm']} | {r['load_start']} | {r['load_end']} | {'yes' if r['noisy'] else ''} | {ms(r['ms'])} |")
