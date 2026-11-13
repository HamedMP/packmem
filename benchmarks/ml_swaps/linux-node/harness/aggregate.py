"""Group run summaries by configuration (tag without _rN), take medians, print Markdown tables.

usage: aggregate.py OUT_ROOT PREFIX   (e.g. q_ or m_)   -> also writes OUT_ROOT/summary_PREFIX.json
"""
import glob
import json
import os
import re
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from summarize import summarize

root, prefix = sys.argv[1], sys.argv[2]
runs = {}
for d in sorted(glob.glob(os.path.join(root, prefix + "*"))):
    if not os.path.exists(os.path.join(d, "meta.json")):
        continue
    s = summarize(d)
    cfg = re.sub(r"_r\d+$", "", os.path.basename(d))
    runs.setdefault(cfg, []).append(s)
json.dump(runs, open(os.path.join(root, f"summary_{prefix}.json"), "w"), indent=1)


def med(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def rng(rs, key, f=lambda x: x):
    v = [f(r[key]) for r in rs if r.get(key) is not None]
    if not v:
        return "-"
    m = statistics.median(v)
    return f"{m:.2f}" if len(v) == 1 else f"{m:.2f} ({min(v):.2f}-{max(v):.2f})"


print("| config | runs | ranks x workers | samples/rank | node PSS peak GiB | node PSS steady GiB | pre-iteration peak GiB | sum RSS peak GiB | per-rank total at peak GiB | rank peak PSS GiB | worker peak PSS GiB (median) | worker USS GiB | build s | loader s | worker 1st batch s (median/max) | load start -> end |")
print("|" + "---|" * 16)
for cfg, rs in runs.items():
    ok = [r for r in rs if r.get("rc") == 0 and r.get("ranks_done") == r.get("nproc")]
    if not ok:
        print(f"| {cfg} | 0 ok of {len(rs)} | {rs[0].get('nproc')}x{rs[0].get('workers')} | {rs[0].get('skipped') or rs[0].get('error') or rs[0].get('rc')} |")
        continue
    r0 = ok[0]
    per_rank = rng(ok, "peak_per_rank_total_pss_gib", lambda x: statistics.median(x.values()))
    wfb = (f"{med([r['worker_first_batch_s']['median'] for r in ok if r.get('worker_first_batch_s')]):.2f} / "
           f"{med([r['worker_first_batch_s']['max'] for r in ok if r.get('worker_first_batch_s')]):.2f}")
    loads = "; ".join(f"{r['load_start'].split()[0]}->{r['load_end'].split()[0]}" for r in ok)
    print(f"| {cfg} | {len(ok)} | {r0['nproc']}x{r0['workers']} {r0['ctx']} | {r0['n_samples_per_rank']} | "
          f"{rng(ok, 'peak_pss_gib')} | {rng(ok, 'steady_pss_gib')} | {rng(ok, 'pre_iter_peak_pss_gib')} | "
          f"{rng(ok, 'peak_rss_sum_gib')} | {per_rank} | {rng(ok, 'rank_peak_pss_gib', lambda x: x['median'])} | "
          f"{rng(ok, 'worker_peak_pss_gib', lambda x: x['median'])} | {rng(ok, 'worker_peak_pss_gib', lambda x: x['uss_median'])} | "
          f"{rng(ok, 'build_s')} | {rng(ok, 'loader_s')} | {wfb} | {loads} |")

print()
print("Hashes per rank (input_ids, labels, position_ids; first 16 hex) and DistributedSampler index hashes:")
seen = {}
for cfg, rs in runs.items():
    for r in rs:
        for rank, h in (r.get("hashes") or {}).items():
            key = (r["n_samples_per_rank"], rank)
            seen.setdefault(key, {}).setdefault(tuple(h), []).append(r["tag"])
for (n, rank), hs in sorted(seen.items(), key=lambda x: (x[0][0], int(x[0][1]))):
    status = "identical" if len(hs) == 1 else "DIFFERENT"
    runs_n = sum(len(v) for v in hs.values())
    print(f"- samples/rank {n}, rank {rank}: {status} across {runs_n} runs -> {list(hs.keys())[0] if len(hs) == 1 else hs}")
