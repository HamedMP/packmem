import glob
import json
import os
import re
import statistics
import sys

H = os.path.dirname(os.path.abspath(__file__))


def parse_time(path):
    t = open(path).read()
    real = float(re.search(r"([\d.]+) real", t).group(1))
    rss = int(re.search(r"(\d+)\s+maximum resident set size", t).group(1))
    fp = int(re.search(r"(\d+)\s+peak memory footprint", t).group(1))
    return {"wall_s": real, "max_rss_mb": rss / 1e6, "peak_footprint_mb": fp / 1e6}


for tag in sys.argv[1:]:
    print(f"== {tag}")
    rows = {}
    for v in ("orig", "repo"):
        runs = []
        for tf in sorted(glob.glob(f"{H}/out/{tag}/{v}_*.time")):
            d = parse_time(tf)
            d.update({k: x for k, x in json.load(open(tf[:-5] + ".json")).items() if isinstance(x, (int, float))})
            j = json.load(open(tf[:-5] + ".json"))
            d["_hashes"] = (j.get("lengths_sha256"), j.get("batches_sha256"))
            d["_ckpt"] = j.get("worker_footprint_checkpoints_mb")
            d["_wfp"] = j.get("worker_footprint_mb")
            runs.append(d)
        rows[v] = runs
        keys = [k for k in runs[0] if not k.startswith("_")]
        med = {k: statistics.median(r[k] for r in runs) for k in keys}
        print(v, len(runs), "runs", {k: round(x, 2) for k, x in med.items()})
        print("  hashes distinct:", set(r["_hashes"] for r in runs))
        if runs[0]["_wfp"]:
            for r in runs:
                print("  worker fp", [round(x) for x in r["_wfp"]], "ckpt", r["_ckpt"])
