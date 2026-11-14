"""Medians for the zero-copy share() v2 tags (Z_*). MB = 1e6 bytes; wprobe's MiB converted.

Peak sum = parent peak (time -l) + each worker's lifetime peak (+ the forkserver process's footprint at the 50% batch,
for forkserver; its lifetime peak is not readable from outside). torch_shm_manager helpers are listed, not summed,
as in the earlier sections.
usage: summarize_z.py TAG...
"""
import glob, json, os, re, statistics as st, sys

H = os.path.dirname(os.path.abspath(__file__))
MIB = 2**20 / 1e6
med = st.median


def runs_of(tag):
    arms = {}
    for jf in sorted(glob.glob(f"{H}/out/{tag}/*.json")):
        base = jf[:-5]
        arm, n = os.path.basename(base).rsplit("_", 1)
        r = json.load(open(jf))
        t = open(base + ".time").read()
        r["parent_peak_mb"] = int(re.search(r"(\d+)\s+peak memory footprint", t).group(1)) / 1e6
        r["wall_s"] = float(re.search(r"([\d.]+) real", t).group(1))
        r["_load"] = [l.split(None, 2)[2].strip() for l in open(base + ".load") if l.startswith(("start", "end"))]
        r["_extra"] = [l.strip() for l in open(base + ".load") if l.startswith("saved file")]
        r["_pkmleft"] = open(base + ".pkmleft").read().split()
        kids = r.get("children_at_50pct", [])
        fs = [k for k in kids if r.get("mp_ctx") == "forkserver" and k["ppid"] == r["pid"]
              and "resource_tracker" not in k["cmd"] and "torch_shm_manager" not in k["cmd"]]
        r["forkserver_mb"] = fs[0]["footprint_mb"] if fs else 0
        r["shm_managers_mb"] = sum(k["footprint_mb"] for k in kids if "torch_shm_manager" in k["cmd"])
        r["peak_sum_mb"] = r["parent_peak_mb"] + r["worker_peak_sum_mb"] * MIB + r["forkserver_mb"]
        arms.setdefault(arm, []).append(r)
    return arms


def rng(vals):
    return [round(min(vals)), round(max(vals))]


for tag in sys.argv[1:]:
    print(f"\n== {tag}")
    for arm, rs in runs_of(tag).items():
        m = lambda f: round(med([f(r) for r in rs]), 2)
        allw = lambda key, scale=1: [x * scale for r in rs for x in r[key]]
        out = {
            "n": len(rs),
            "parent_peak_mb": m(lambda r: r["parent_peak_mb"]),
            "worker_init_fp_mb": rng(allw("worker_init_mb", MIB)),
            "worker_init_rss_mb": rng(allw("worker_init_rss_mb", MIB)),
            "worker_50pct_fp_mb": rng([x for r in rs for x in r["worker_footprint_checkpoints_mb"][1][1]]),
            "worker_90pct_fp_mb": rng(allw("worker_footprint_mb")),
            "worker_90pct_rss_mb": rng(allw("worker_rss_mb")),
            "worker_peak_mb": rng(allw("worker_peak_mb", MIB)),
            "forkserver_mb": m(lambda r: r["forkserver_mb"]),
            "shm_managers_mb": m(lambda r: r["shm_managers_mb"]),
            "peak_sum_mb": m(lambda r: r["peak_sum_mb"]),
            "peak_sum_runs": [round(r["peak_sum_mb"]) for r in rs],
            "start_to_first_by_worker_s": [round(med([r["worker_start_to_first_batch_s"][k] for r in rs]), 2) for k in range(4)],
            "iter_to_first_s": m(lambda r: r["iter_to_first_batch_s"]),
            "iter_to_first_runs": [round(r["iter_to_first_batch_s"], 2) for r in rs],
            "iter_to_last_s": m(lambda r: r["iter_to_last_batch_s"]),
            "iter_to_last_runs": [round(r["iter_to_last_batch_s"], 2) for r in rs],
            "build_s": m(lambda r: r["build_s"]),
            "wall_s": m(lambda r: r["wall_s"]),
            "hashes": sorted({(r["lengths_sha256"][:10], r["batches_sha256"][:10]) for r in rs}),
            "loads": [r["_load"] for r in rs],
        }
        if "pkm_path" in rs[0]:
            out["pkm"] = sorted({(r["pkm_dir"], r["pkm_bytes"], r["pkm_mode"]) for r in rs})
            out["resident_after_build"] = [r.get("pkm_resident_after_build") for r in rs]
            out["resident_before_iter"] = [r.get("pkm_resident_before_iter") for r in rs]
            out["resident_after_run"] = [r.get("pkm_resident_after_epoch") for r in rs]
            out["evict_s"] = [r.get("evict_s") for r in rs]
            out["pkm_exists_after_run"] = [r.get("pkm_exists_after_epoch") for r in rs]
        out["pkm_left"] = [r["_pkmleft"] for r in rs]
        out["saved_file_after_exit"] = [r["_extra"] for r in rs]
        print(arm, json.dumps(out))
