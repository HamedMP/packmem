"""One variant per process: load a real dataset, report memory and query times as JSON."""
import gc, json, os, random, resource, sys, time
variant, ds = sys.argv[1], sys.argv[2]
import mem
rss = mem.resident
def med(f, reps=5):
    ts = []
    for _ in range(reps):
        t = time.perf_counter(); r = f(); ts.append((time.perf_counter() - t) * 1e3)
    return round(sorted(ts)[reps // 2], 3), r
P = {"flights": "flights.jsonl", "nginx": "nginx.jsonl"}[ds]
if variant == "pandas" or variant == "pandas_arrow": import pandas as pd
if variant == "polars": import polars as pl
if variant.startswith("packmem"): import packmem
gc.collect(); base = rss(); fbase = mem.footprint(); t0 = time.perf_counter()
if variant == "list":            rows = [json.loads(l) for l in open(P)]
elif variant == "packmem":       rows = packmem.load_jsonl(P)
elif variant == "packmem_speed": rows = packmem.load_jsonl(P, hint="speed")
elif variant == "packmem_file":  rows = packmem.load_jsonl(open(P))          # any iterable of lines
elif variant == "packmem_wrap":  rows = packmem.Table(json.loads(l) for l in open(P))   # wrap existing records
elif variant == "pandas":        rows = pd.read_json(P, lines=True)
elif variant == "pandas_arrow":  rows = pd.read_json(P, lines=True, dtype_backend="pyarrow", engine="pyarrow")
elif variant == "polars":        rows = pl.read_ndjson(P)
load = time.perf_counter() - t0; gc.collect()
out = {"variant": variant, "dataset": ds, "rows": len(rows), "load_s": round(load, 2), "rss_mb": round(rss() - base, 1), "footprint_mb": round(mem.footprint() - fbase, 1), "peak_mb": round(mem.peak(), 1)}
n = len(rows); rnd = random.Random(1); idx = [rnd.randrange(n) for _ in range(10_000)]
kind = "packmem" if variant.startswith("packmem") else variant
if ds == "flights":
    Q = {
     "count carrier=UA": {"list": lambda: sum(1 for r in rows if r["carrier"] == "UA"), "packmem": lambda: rows.count(carrier="UA"),
        "pandas": lambda: int((rows["carrier"] == "UA").sum()), "polars": lambda: rows.filter(pl.col("carrier") == "UA").height},
     "sum distance where origin=JFK": {"list": lambda: sum(r["distance"] for r in rows if r["origin"] == "JFK"), "packmem": lambda: rows.sum("distance", origin="JFK"),
        "pandas": lambda: int(rows.loc[rows["origin"] == "JFK", "distance"].sum()), "polars": lambda: rows.filter(pl.col("origin") == "JFK")["distance"].sum()},
     "group count by dest": {"list": lambda: __import__("collections").Counter(r["dest"] for r in rows)["ORD"], "packmem": lambda: rows.group_count("dest")["ORD"],
        "pandas": lambda: int(rows["dest"].value_counts()["ORD"]), "polars": lambda: rows.group_by("dest").len().filter(pl.col("dest") == "ORD")["len"][0]},
     "count dep_delay>60": {"list": lambda: sum(1 for r in rows if r["dep_delay"] is not None and r["dep_delay"] > 60), "packmem": lambda: rows.count(dep_delay__gt=60),
        "pandas": lambda: int((rows["dep_delay"] > 60).sum()), "polars": lambda: rows.filter(pl.col("dep_delay") > 60).height},
     "sum air_time": {"list": lambda: sum(r["air_time"] for r in rows if r["air_time"] is not None), "packmem": lambda: rows.sum("air_time"),
        "pandas": lambda: float(rows["air_time"].sum()), "polars": lambda: rows["air_time"].sum()},
     "10k random rows as dicts": {"list": lambda: sum(rows[i]["flight"] for i in idx), "packmem": lambda: sum(rows[i]["flight"] for i in idx),
        "pandas": lambda: sum(rows.iloc[i].to_dict()["flight"] for i in idx[:500]) , "polars": lambda: sum(rows.row(i, named=True)["flight"] for i in idx)},
     "loop over every row": {"list": lambda: sum(r["distance"] for r in rows), "packmem": lambda: sum(r["distance"] for r in rows),
        "pandas": lambda: sum(r["distance"] for r in rows.to_dict("records")), "polars": lambda: sum(r["distance"] for r in rows.iter_rows(named=True))},
    }
else:
    Q = {
     "count response=404": {"list": lambda: sum(1 for r in rows if r["response"] == 404), "packmem": lambda: rows.count(response=404),
        "pandas": lambda: int((rows["response"] == 404).sum()), "polars": lambda: rows.filter(pl.col("response") == 404).height},
     "sum bytes where agent contains Debian": {"list": lambda: sum(r["bytes"] for r in rows if "Debian" in r["agent"]), "packmem": lambda: rows.sum("bytes", agent__contains="Debian"),
        "pandas": lambda: int(rows.loc[rows["agent"].str.contains("Debian", regex=False), "bytes"].sum()), "polars": lambda: rows.filter(pl.col("agent").str.contains("Debian", literal=True))["bytes"].sum()},
     "group count by remote_ip": {"list": lambda: len(__import__("collections").Counter(r["remote_ip"] for r in rows)), "packmem": lambda: len(rows.group_count("remote_ip")),
        "pandas": lambda: int(rows["remote_ip"].nunique()), "polars": lambda: rows.group_by("remote_ip").len().height},
     "count request prefix": {"list": lambda: sum(1 for r in rows if r["request"].startswith("GET /downloads/product_2")), "packmem": lambda: rows.count(request__prefix="GET /downloads/product_2"),
        "pandas": lambda: int(rows["request"].str.startswith("GET /downloads/product_2").sum()), "polars": lambda: rows.filter(pl.col("request").str.starts_with("GET /downloads/product_2")).height},
     "10k random rows as dicts": {"list": lambda: sum(rows[i]["bytes"] for i in idx), "packmem": lambda: sum(rows[i]["bytes"] for i in idx),
        "pandas": lambda: sum(rows.iloc[i].to_dict()["bytes"] for i in idx[:500]), "polars": lambda: sum(rows.row(i, named=True)["bytes"] for i in idx)},
     "loop over every row": {"list": lambda: sum(r["bytes"] for r in rows), "packmem": lambda: sum(r["bytes"] for r in rows),
        "pandas": lambda: sum(r["bytes"] for r in rows.to_dict("records")), "polars": lambda: sum(r["bytes"] for r in rows.iter_rows(named=True))},
    }
k2 = "pandas" if kind == "pandas_arrow" else kind
out["q"] = {}
for name, impl in Q.items():
    ms, res = med(impl[k2], 3 if name.startswith("loop") else 5)
    if name.startswith("10k") and k2 == "pandas": ms = round(ms * 20, 1); res = None   # measured on 500 lookups, scaled
    out["q"][name] = [ms, res if not isinstance(res, float) else round(res, 3)]
if kind == "packmem" and hasattr(rows, "lazy"):
    col = "distance" if ds == "flights" else "bytes"
    ms, res = med(lambda: sum(r[col] for r in rows.lazy()), 3); out["q"]["loop over every row, lazy rows"] = [ms, res]
if kind == "packmem": out["packed_mb"] = round(rows.nbytes / 1e6, 2)
print(json.dumps(out))
