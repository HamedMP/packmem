import json, re, statistics, sys, glob
B = sys.argv[1]
for v in ("orig", "patched"):
    rows = []
    for i in range(1, 6):
        t = open(f"{B}/runs/t_{v}_{i}.time").read()
        j = json.load(open(f"{B}/runs/t_{v}_{i}.json"))
        rows.append(dict(wall=float(re.search(r"([\d.]+) real", t).group(1)),
                         peak=int(re.search(r"(\d+)\s+maximum resident", t).group(1)) / 2**20, **j))
    med = lambda k: statistics.median(r[k] for r in rows)
    print(v, {k: round(med(k), 3) for k in ("wall", "peak", "load_s", "lengths_s", "modality_lengths_s", "getitem_lookups_10k_s",
                                             "rss_before_load_mb", "rss_after_load_mb", "rss_end_mb")})
    print("  walls", [r["wall"] for r in rows], "peaks", [round(r["peak"]) for r in rows])
