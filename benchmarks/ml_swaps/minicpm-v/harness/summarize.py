import json, statistics as st, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
for w in sorted({r["workers"] for r in rows}):
    print(f"\nworkers={w}")
    for arm in ("repo-orig", "repo"):
        rs = [r for r in rows if r["workers"] == w and r["arm"] == arm]
        if not rs: continue
        med = lambda f: st.median(f(r) for r in rs)
        print(arm, len(rs), "runs",
              "wall", med(lambda r: r["wall_s"]),
              "maxrss_MB", round(med(lambda r: r["max_rss"]) / 2**20),
              "peakfp_MB", round(med(lambda r: r["peak_footprint"]) / 2**20),
              "load_s", med(lambda r: r["r"]["load_s"]),
              "iter_s", med(lambda r: r["r"]["iter_s"]),
              "fp_after_load", med(lambda r: r["r"]["footprint_after_load_mb"]),
              "workers_fp", med(lambda r: r["r"]["workers_peak_footprint_sum_mb"]),
              "main+workers", med(lambda r: r["r"]["main_plus_workers_footprint_mb"]),
              "hashes", sorted({r["r"]["sha256"][:12] for r in rs}))
