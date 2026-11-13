"""Summarize run directories written by run.sh (monitor.jsonl, rank*.json, probe/, meta.json).

usage: summarize.py OUT_ROOT TAG...   -> one JSON line per run on stdout
GiB = 2**30 bytes. PSS/RSS/USS sums are over every process under torchrun (launcher, ranks,
forkservers, resource trackers, workers).
"""
import glob
import json
import os
import statistics
import sys

GIB_KB = 2**20


def load_run(d):
    meta = json.load(open(os.path.join(d, "meta.json")))
    ranks = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(d, "rank*.json")))]
    probes = [json.load(open(p)) for p in glob.glob(os.path.join(d, "probe", "w*.json"))]
    samples = [json.loads(l) for l in open(os.path.join(d, "monitor.jsonl")) if l.strip()]
    samples = [s for s in samples if "p" in s]
    return meta, ranks, probes, samples


def tot(s, col, roles=None):
    i = {"rss": 4, "pss": 5, "pss_anon": 6, "uss": 7, "swap": 8}[col]
    return sum(r[i] for r in s["p"] if roles is None or r[2] in roles) / GIB_KB


def summarize(d):
    meta, ranks, probes, S = load_run(d)
    out = dict(meta)
    if not ranks or not S:
        out["error"] = "no rank results"
        return out
    out["ranks_done"] = len(ranks)
    node_pss = [tot(s, "pss") + tot(s, "swap") for s in S]
    ip = max(range(len(S)), key=lambda i: node_pss[i])
    peak = S[ip]
    out["peak_pss_gib"] = node_pss[ip]
    out["peak_rss_sum_gib"] = max(tot(s, "rss") for s in S)
    out["peak_uss_sum_gib"] = max(tot(s, "uss") for s in S)
    out["peak_breakdown_pss_gib"] = {r: tot(peak, "pss", {r}) for r in ("launcher", "rank", "forkserver", "tracker", "worker", "other")}
    out["peak_nproc"] = len(peak["p"])
    out["swap_pss_max_gib"] = max(tot(s, "swap") for s in S)
    # Iteration window common to all ranks: every rank has its first batch .. first rank finishes.
    w0 = max(r["t_first_batch"] for r in ranks)
    w1 = min(r["t_last_batch"] for r in ranks)
    mid = w0 + 0.5 * (w1 - w0)
    steady = [node_pss[i] for i, s in enumerate(S) if mid <= s["t"] <= w1]
    out["steady_window_s"] = [round(mid - w0, 2), round(w1 - w0, 2)]
    out["steady_nsamples"] = len(steady)
    out["steady_pss_gib"] = statistics.median(steady) if steady else None
    # Before any worker exists: peak while ranks load and build (includes json.load transients).
    t_it = min(r["t_iter_start"] for r in ranks)
    pre = [node_pss[i] for i, s in enumerate(S) if s["t"] <= t_it]
    out["pre_iter_peak_pss_gib"] = max(pre) if pre else None
    # Per-process peaks.
    per = {}
    for s in S:
        for pid, ppid, role, rank, rss, pss, pa, uss, sw in s["p"]:
            e = per.setdefault(pid, {"role": role, "rank": rank, "pss": 0, "rss": 0, "uss": 0})
            e["pss"] = max(e["pss"], pss + sw); e["rss"] = max(e["rss"], rss); e["uss"] = max(e["uss"], uss)
    for role in ("rank", "worker", "forkserver"):
        ps = [e for e in per.values() if e["role"] == role]
        if ps:
            out[f"{role}_peak_pss_gib"] = {"n": len(ps), "median": statistics.median(e["pss"] for e in ps) / GIB_KB,
                                           "max": max(e["pss"] for e in ps) / GIB_KB,
                                           "rss_median": statistics.median(e["rss"] for e in ps) / GIB_KB,
                                           "uss_median": statistics.median(e["uss"] for e in ps) / GIB_KB}
    # Per-rank totals at the peak sample (rank + its workers/forkserver/tracker).
    by_rank = {}
    for row in peak["p"]:
        if row[3] >= 0:
            by_rank[row[3]] = by_rank.get(row[3], 0) + row[5] + row[8]
    out["peak_per_rank_total_pss_gib"] = {k: v / GIB_KB for k, v in sorted(by_rank.items())}
    out["build_s"] = statistics.median(r["build_s"] for r in ranks)
    out["build_s_max"] = max(r["build_s"] for r in ranks)
    out["loader_s"] = statistics.median(r["loader_s"] for r in ranks)
    out["rank_iter_to_first_batch_s"] = statistics.median(r["iter_to_first_batch_s"] for r in ranks)
    it0 = {r["rank"]: r["t_iter_start"] for r in ranks}
    fb = [p["first_batch"] - it0[p["rank"]] for p in probes if "first_batch" in p and p.get("rank") in it0]
    if fb:
        out["worker_first_batch_s"] = {"n": len(fb), "median": statistics.median(fb), "max": max(fb)}
    out["n_samples_per_rank"] = ranks[0]["n_samples"]
    out["hashes"] = {r["rank"]: [r["input_ids_sha256"][:16], r["labels_sha256"][:16], r["position_ids_sha256"][:16]] for r in ranks}
    out["idx_hashes"] = {r["rank"]: r["idx_sha256"][:16] for r in ranks}
    out["sample_interval_s"] = statistics.median(b["t"] - a["t"] for a, b in zip(S, S[1:])) if len(S) > 1 else None
    out["sample_cost_s_max"] = max(s["dt"] for s in S)
    out["min_avail_gib"] = min(s["avail_kb"] for s in S) / GIB_KB
    return out


if __name__ == "__main__":
    root = sys.argv[1]
    for tag in sys.argv[2:]:
        print(json.dumps(summarize(os.path.join(root, tag))))
