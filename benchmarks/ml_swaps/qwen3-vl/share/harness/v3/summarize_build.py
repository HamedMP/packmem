"""Medians for the build re-measure: Qwen3-VL build-mode tags (MB = 1e6) and LLaVA-NeXT runs.sh results (MiB, as v2).

usage: summarize_build.py QWEN_TAG... -- LLAVA_RESULTS_JSONL
"""
import glob, json, os, re, statistics as st, sys

H = os.path.dirname(os.path.abspath(__file__))
med = st.median
argv = sys.argv[1:]
cut = argv.index("--") if "--" in argv else len(argv)
qtags, rest = argv[:cut], argv[cut + 1:]

for tag in qtags:
    print(f"\n== qwen {tag}")
    for arm in ("orig", "repo"):
        runs = []
        for jf in sorted(glob.glob(f"{H}/out/{tag}/{arm}_*.json")):
            r = json.load(open(jf))
            t = open(jf[:-5] + ".time").read()
            r["peak_fp_mb"] = int(re.search(r"(\d+)\s+peak memory footprint", t).group(1)) / 1e6
            r["wall_s"] = float(re.search(r"([\d.]+) real", t).group(1))
            r["_load"] = [l.split(None, 2)[2].strip() for l in open(jf[:-5] + ".load") if l.startswith(("start", "end"))]
            runs.append(r)
        if not runs:
            continue
        out = {"n": len(runs)}
        for k in ("build_s", "peak_fp_mb", "footprint_after_build_mb", "lengths_s", "modality_lengths_s", "getitem_s", "wall_s"):
            if k in runs[0]:
                out[k] = round(med([r[k] for r in runs]), 2)
                out[k + "_runs"] = [round(r[k], 2) for r in runs]
        out["table_nbytes"] = sorted({r.get("table_nbytes") for r in runs}, key=str)
        out["hashes"] = sorted({(r.get("lengths_sha256", "")[:10], r.get("batches_sha256", "")[:10], r.get("rows_sha256", "")[:10]) for r in runs})
        out["loads"] = [r["_load"] for r in runs]
        print(arm, json.dumps(out))

if rest:
    rows = [json.loads(l) for l in open(rest[0]) if l.strip()]
    groups = {}
    for x in rows:
        groups.setdefault((x["tag"], x["arm"]), []).append(x)
    for (tag, arm), runs in groups.items():
        rs = [x["r"] for x in runs]
        out = {"n": len(runs), "threads": sorted({x["threads"] for x in runs})}
        out["load_s"] = round(med([r["load_s"] for r in rs]), 2)
        out["load_s_runs"] = [r["load_s"] for r in rs]
        out["peak_fp_mib"] = round(med([x["peak_footprint"] / 2**20 for x in runs]))
        out["peak_fp_runs_mib"] = [round(x["peak_footprint"] / 2**20) for x in runs]
        out["fp_after_load_mib"] = round(med([r["footprint_after_load_mb"] for r in rs]))
        out["lengths_s"] = round(med([r["lengths_s"] for r in rs]), 2)
        out["modality_lengths_s"] = round(med([r["modality_lengths_s"] for r in rs]), 2)
        out["iter_s"] = round(med([r["iter_s"] for r in rs]), 2)
        out["wall_s"] = round(med([x["wall_s"] for x in runs]), 2)
        out["hashes"] = sorted({(r["lengths_sha"][:10], r["sha256"][:12]) for r in rs})
        out["loads"] = [(x["load_start"], x["load_end"]) for x in runs]
        print(f"llava {tag} {arm}", json.dumps(out))
