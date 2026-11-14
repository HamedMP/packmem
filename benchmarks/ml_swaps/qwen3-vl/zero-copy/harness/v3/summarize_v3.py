"""Medians per tag and arm from harness/v3/out. Everything in MB = 1e6 bytes (wprobe's MiB converted), as in v2."""
import glob, json, os, re, statistics as st, sys

H = os.path.dirname(os.path.abspath(__file__))
MIB = 2**20 / 1e6
med = st.median


def parse_time(path):
    t = open(path).read()
    return {
        "wall_s": float(re.search(r"([\d.]+) real", t).group(1)),
        "parent_peak_fp_mb": int(re.search(r"(\d+)\s+peak memory footprint", t).group(1)) / 1e6,
        "parent_max_rss_mb": int(re.search(r"(\d+)\s+maximum resident set size", t).group(1)) / 1e6,
    }


def load(tag, arm):
    runs = []
    for jf in sorted(glob.glob(f"{H}/out/{tag}/{arm}_*.json")):
        base = jf[:-5]
        r = json.load(open(jf))
        r.update(parse_time(base + ".time"))
        r["_load"] = [l.split(None, 2)[2] for l in open(base + ".load") if l.startswith(("start", "end"))]
        r["_pkmleft"] = open(base + ".pkmleft").read().split() if os.path.exists(base + ".pkmleft") else None
        r["_run"] = base.rsplit("_", 1)[1]
        runs.append(r)
    return runs


def loader_row(runs):
    out = {"n_runs": len(runs)}
    m = lambda f: round(med([f(r) for r in runs]), 2)
    out["parent_peak_mb"] = m(lambda r: r["parent_peak_fp_mb"])
    out["parent_peak_runs"] = [round(r["parent_peak_fp_mb"]) for r in runs]
    out["worker_peak_mb_range"] = [round(min(x for r in runs for x in r["worker_peak_mb"]) * MIB),
                                   round(max(x for r in runs for x in r["worker_peak_mb"]) * MIB)]
    out["worker_peak_sum_mb"] = m(lambda r: r["worker_peak_sum_mb"] * MIB)
    out["peak_sum_mb"] = m(lambda r: r["parent_peak_fp_mb"] + r["worker_peak_sum_mb"] * MIB)
    out["peak_sum_runs"] = [round(r["parent_peak_fp_mb"] + r["worker_peak_sum_mb"] * MIB) for r in runs]
    out["worker_init_mb_range"] = [round(min(x for r in runs for x in r["worker_init_mb"]) * MIB),
                                   round(max(x for r in runs for x in r["worker_init_mb"]) * MIB)]
    out["worker_90pct_fp_mb_range"] = [round(min(x for r in runs for x in r["worker_footprint_mb"])),
                                       round(max(x for r in runs for x in r["worker_footprint_mb"]))]
    out["worker_90pct_rss_mb_range"] = [round(min(x for r in runs for x in r["worker_rss_mb"])),
                                        round(max(x for r in runs for x in r["worker_rss_mb"]))]
    out["at90_total_runs"] = [round(r["total_footprint_mb"]) for r in runs]
    out["parent_at90_runs"] = [round(r["main_footprint_at_90pct_mb"]) for r in runs]
    # per worker id, median across runs
    nw = len(runs[0]["worker_start_to_first_batch_s"])
    out["start_to_first_batch_by_worker_s"] = [round(med([r["worker_start_to_first_batch_s"][k] for r in runs]), 2) for k in range(nw)]
    out["iter_to_first_batch_by_worker_s"] = [round(med([r["worker_iter_to_first_batch_s"][k] for r in runs]), 2) for k in range(nw)]
    out["iter_to_first_batch_s"] = m(lambda r: r["iter_to_first_batch_s"])
    out["iter_to_first_runs"] = [round(r["iter_to_first_batch_s"], 2) for r in runs]
    out["iter_to_last_batch_s"] = m(lambda r: r["iter_to_last_batch_s"])
    out["iter_to_last_runs"] = [round(r["iter_to_last_batch_s"], 2) for r in runs]
    out["wall_s"] = m(lambda r: r["wall_s"])
    out["walls"] = [r["wall_s"] for r in runs]
    out["build_s"] = m(lambda r: r["build_s"])
    out["lengths_s"] = m(lambda r: r["lengths_s"] + r["modality_lengths_s"])
    out["hashes"] = sorted({(r["lengths_sha256"][:10], r["batches_sha256"][:10]) for r in runs})
    out["n_samples"] = sorted({r["n_samples"] for r in runs})
    if "pkm_path" in runs[0]:
        out["pkm"] = sorted({(r["pkm_dir"], r["pkm_bytes"], r["pkm_mode"]) for r in runs})
        out["pkm_exists_after_epoch"] = [r.get("pkm_exists_after_epoch") for r in runs]
    out["pkm_left_after_exit"] = [r["_pkmleft"] for r in runs]
    out["loads"] = {r["_run"]: r["_load"] for r in runs}
    return out


for tag in sys.argv[1:]:
    print(f"\n== {tag}")
    for arm in ("orig", "repo", "repo-share"):
        runs = load(tag, arm)
        if not runs:
            continue
        if runs[0]["mode"] == "loader":
            print(arm, json.dumps(loader_row(runs)))
        else:
            r = runs[0]
            keep = {k: v for k, v in r.items() if k not in ("tree", "datasets", "pkm_path")}
            print(arm, json.dumps(keep))
