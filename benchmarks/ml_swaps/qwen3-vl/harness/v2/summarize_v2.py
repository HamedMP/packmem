"""Medians per tag and arm from harness/v2/out. MB = 1e6 bytes (as v1) unless the key says mib."""
import glob, json, os, re, statistics as st, sys
H = os.path.dirname(os.path.abspath(__file__))
med = st.median


def parse_time(path):
    t = open(path).read()
    real = float(re.search(r"([\d.]+) real", t).group(1))
    rss = int(re.search(r"(\d+)\s+maximum resident set size", t).group(1))
    fp = int(re.search(r"(\d+)\s+peak memory footprint", t).group(1))
    return {"wall_s": real, "max_rss_mb": rss / 1e6, "peak_footprint_mb": fp / 1e6}


for tag in sys.argv[1:]:
    print(f"\n== {tag}")
    for v in ("orig", "repo"):
        runs = []
        for tf in sorted(glob.glob(f"{H}/out/{tag}/{v}_*.time")):
            j = json.load(open(tf[:-5] + ".json"))
            d = parse_time(tf)
            d.update(j)
            d["_load"] = open(tf[:-5] + ".load").read().strip() if os.path.exists(tf[:-5] + ".load") else None
            runs.append(d)
        if not runs:
            continue
        num = [k for k, x in runs[0].items() if isinstance(x, (int, float)) and not isinstance(x, bool) and not k.startswith("_")]
        out = {k: round(med([r[k] for r in runs if k in r]), 2) for k in num}
        out["n_runs"] = len(runs)
        if "worker_footprint_mb" in runs[0]:
            out["total_at_90pct_runs_mb"] = [round(r["total_footprint_mb"]) for r in runs]
            out["peaksum_runs_mib"] = [round(r["main_peak_plus_worker_peaks_mib"]) for r in runs]
            out["conc_runs_mib"] = [round(r["max_concurrent_total_mib"]) for r in runs]
            out["worker_peak_mib_runs"] = [r["worker_peak_mb"] for r in runs]
            out["worker_90pct_mb_runs"] = [[round(x) for x in r["worker_footprint_mb"]] for r in runs]
            out["ckpt_runs"] = [r.get("worker_footprint_checkpoints_mb") for r in runs]
            out["start_to_first_batch_runs"] = [r["worker_start_to_first_batch_s"] for r in runs]
            out["iter_to_first_batch_runs"] = [r["worker_iter_to_first_batch_s"] for r in runs]
            out["iter_to_last_batch_runs"] = [round(r["iter_to_last_batch_s"], 1) for r in runs]
        out["walls"] = [r["wall_s"] for r in runs]
        out["peakfp_runs"] = [round(r["peak_footprint_mb"]) for r in runs]
        out["loads"] = [r["_load"] for r in runs]
        out["hashes"] = sorted({(str(r.get("lengths_sha256"))[:10], str(r.get("batches_sha256"))[:10], str(r.get("rows_sha256"))[:10]) for r in runs})
        for k in ("roundtrip_equal", "dumps_s", "mp_ctx"):
            if k in runs[0]:
                out[k] = [r[k] for r in runs]
        print(v, json.dumps(out))
