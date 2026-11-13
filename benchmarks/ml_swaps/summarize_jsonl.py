"""Medians per (workers, ctx, arm) from a results_v2.jsonl (MiniCPM-V and LLaVA-NeXT drivers). MiB."""
import json, statistics as st, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
bad = [r for r in rows if r["r"] is None]
if bad:
    print("FAILED RUNS:", [(r["arm"], r["workers"], r["ctx"], r["run"]) for r in bad])
rows = [r for r in rows if r["r"] is not None]
med = lambda xs: st.median(xs) if xs else None
for cfg in sorted({(r["workers"], r["ctx"]) for r in rows}):
    print(f"\n== workers={cfg[0]} ctx={cfg[1] if cfg[0] else '-'}")
    for arm in ("repo-orig", "repo"):
        rs = [r for r in rows if (r["workers"], r["ctx"]) == cfg and r["arm"] == arm]
        if not rs:
            continue
        g = lambda k: med([r["r"][k] for r in rs if k in r["r"]])
        out = {"n": len(rs), "wall_s": med([r["wall_s"] for r in rs]),
               "time_l_maxrss_mib": round(med([r["max_rss"] for r in rs]) / 2**20),
               "time_l_peakfp_mib": round(med([r["peak_footprint"] for r in rs]) / 2**20)}
        for k in ("load_s", "lengths_s", "modality_lengths_s", "footprint_after_load_mb", "iter_to_first_batch_s",
                  "iter_to_last_batch_s", "iter_s", "main_lifetime_peak_mb", "max_concurrent_total_mb",
                  "worker_peak_sum_mb", "main_peak_plus_worker_peaks_mb"):
            v = g(k)
            if v is not None:
                out[k] = round(v, 2)
        if cfg[0]:
            for k in ("worker_peak_mb", "worker_start_to_first_batch_s", "worker_iter_to_first_batch_s", "worker_iter_to_init_s"):
                per = [sorted(r["r"][k]) for r in rs if k in r["r"]]
                out[k + "_median_per_rank"] = [round(med([p[i] for p in per]), 2) for i in range(len(per[0]))] if per else None
                out[k + "_range"] = [round(min(min(p) for p in per), 2), round(max(max(p) for p in per), 2)] if per else None
        out["walls"] = [r["wall_s"] for r in rs]
        out["peaksum_runs"] = [r["r"].get("main_peak_plus_worker_peaks_mb") for r in rs]
        out["loads"] = [r.get("load1") or r.get("load") for r in rs]
        out["hashes"] = sorted({r["r"]["sha256"][:12] for r in rs})
        print(arm, json.dumps(out))
