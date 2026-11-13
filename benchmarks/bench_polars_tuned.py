"""One holder per process with polars tuned for memory: report memory, load time and query times as JSON.

usage: python bench_polars_tuned.py <variant> <dataset> <work_dir>
Run from the data directory. <work_dir> holds the tuned parquet files, the known schemas and
flights_big.jsonl (see run_polars_tuned.py).

variants:
  list                 json.loads per line into a list of dicts
  packmem              packmem.load_jsonl
  polars               pl.read_ndjson, inferred dtypes (what bench.py measures)
  polars_rechunk       the same, then rechunk(): read_ndjson returns about 200 chunks per column
  polars_tuned         pl.read_ndjson, then Enum for string columns (categories found in the
                       data at load time), the smallest integer type that holds each column, rechunk()
  polars_tuned_scan    pl.scan_ndjson(...).cast(known schema).collect().rechunk(): schema known in advance
  polars_parquet       pl.read_parquet of a file written with the tuned schema, then rechunk()
  prep                 writes <work_dir>/<dataset>_tuned.parquet and <dataset>_schema.json
"""
import gc, json, os, random, sys, time
variant, ds, work = sys.argv[1], sys.argv[2], sys.argv[3]
import mem
rss = mem.resident

P = {"flights": "flights.jsonl", "nginx": "nginx.jsonl", "logs": "logs_2m.jsonl",
     "flights_big": os.path.join(work, "flights_big.jsonl")}[ds]
PARQUET = os.path.join(work, f"{ds}_tuned.parquet")
SCHEMA = os.path.join(work, f"{ds}_schema.json")
base_ds = "flights" if ds.startswith("flights") else ds

# Smallest integer type for every value in these data sets; a strict cast raises if one does not fit.
# Float columns in flights hold whole minutes with nulls, so they become integers too.
INTS = {
    "flights": {"Int16": ["year", "dep_time", "sched_dep_time", "dep_delay", "arr_time", "sched_arr_time",
                          "arr_delay", "flight", "air_time", "distance"],
                "UInt8": ["month", "day", "hour", "minute"]},
    "nginx": {"UInt16": ["response"], "UInt32": ["bytes"]},
    "logs": {"UInt32": ["user_id", "bytes", "latency_us"], "UInt16": ["status"]},
}[base_ds]
ENUMS = {
    "flights": ["carrier", "tailnum", "origin", "dest", "time_hour"],
    "nginx": ["time", "remote_ip", "remote_user", "request", "referrer", "agent"],
    "logs": ["method", "path", "ip", "country", "ua"],          # session is unique per row: stays String
}[base_ds]

if variant == "list": pass
elif variant == "packmem": import packmem
else: import polars as pl


def tuned_schema(df):
    s = {c: getattr(pl, t) for t, cols in INTS.items() for c in cols}
    s.update({c: pl.Enum(df[c].drop_nulls().unique().sort()) for c in ENUMS})
    return s


def known_schema():
    j = json.load(open(SCHEMA))
    s = {c: getattr(pl, t) for c, t in j["ints"].items()}
    s.update({c: pl.Enum(v) for c, v in j["enums"].items()})
    return s


if variant == "prep":
    df = pl.read_ndjson(P); s = tuned_schema(df); t = df.cast(s)
    t.write_parquet(PARQUET, statistics=False)
    json.dump({"ints": {c: t for t, cols in INTS.items() for c in cols},
               "enums": {c: s[c].categories.to_list() for c in ENUMS}}, open(SCHEMA, "w"))
    print(json.dumps({"prep": ds, "rows": t.height, "untuned_mb": round(df.estimated_size("mb"), 2),
                      "tuned_mb": round(t.estimated_size("mb"), 2),
                      "categorical_u32_mb": round(df.cast({c: pl.Categorical for c in ENUMS}).cast({c: v for c, v in s.items() if c not in ENUMS}).estimated_size("mb"), 2),
                      "parquet_mb": round(os.path.getsize(PARQUET) / 1e6, 2),
                      "dtypes": {c: str(d) if not isinstance(d, pl.Enum) else f"Enum[{d.categories.len()}] {t[c].to_physical().dtype}" for c, d in t.schema.items()}}))
    sys.exit()

if variant == "polars_tuned_scan": ks = known_schema()   # reading the schema is not part of the load


def med(f, reps=5):
    ts = []
    for _ in range(reps):
        t = time.perf_counter(); r = f(); ts.append((time.perf_counter() - t) * 1e3)
    return round(sorted(ts)[reps // 2], 3), r


gc.collect(); base = rss(); fbase = mem.footprint(); t0 = time.perf_counter()
if variant == "list":                rows = [json.loads(l) for l in open(P)]
elif variant == "packmem":           rows = packmem.load_jsonl(P)
elif variant == "polars":            rows = pl.read_ndjson(P)
elif variant == "polars_rechunk":    rows = pl.read_ndjson(P).rechunk()
elif variant == "polars_tuned":
    rows = pl.read_ndjson(P); rows = rows.cast(tuned_schema(rows)).rechunk()
elif variant == "polars_tuned_scan": rows = pl.scan_ndjson(P).cast(ks).collect().rechunk()
elif variant == "polars_parquet":    rows = pl.read_parquet(PARQUET).rechunk()
else: sys.exit(f"unknown variant {variant}")
load = time.perf_counter() - t0; gc.collect()
out = {"variant": variant, "dataset": ds, "rows": len(rows), "load_s": round(load, 3), "rss_mb": round(rss() - base, 1),
       "footprint_mb": round(mem.footprint() - fbase, 1), "peak_mb": round(mem.peak(), 1)}
if variant.startswith("polars"): out["data_mb"] = round(rows.estimated_size("mb"), 2); out["chunks"] = max(rows.n_chunks("all"))
if variant == "packmem": out["data_mb"] = round(rows.nbytes / 1e6, 2)

n = len(rows); rnd = random.Random(1); idx = [rnd.randrange(n) for _ in range(10_000)]
kind = "polars" if variant.startswith("polars") else variant
tuned = variant in ("polars_tuned", "polars_tuned_scan", "polars_parquet")
C = __import__("collections").Counter


def contains(col, s):
    """Substring filter. On an Enum, match the categories once and filter on the codes."""
    if not tuned: return pl.col(col).str.contains(s, literal=True)
    cats = pl.Series(rows.schema[col].categories)
    return pl.col(col).is_in(cats.filter(cats.str.contains(s, literal=True)).implode())


def prefix(col, s): return pl.col(col).cat.starts_with(s) if tuned else pl.col(col).str.starts_with(s)
def psum(df, col): return df.select(pl.col(col).cast(pl.Int64).sum()).item()   # UInt32 sums overflow silently


if base_ds == "flights":
    Q = {
     "count carrier=UA": {"list": lambda: sum(1 for r in rows if r["carrier"] == "UA"), "packmem": lambda: rows.count(carrier="UA"),
        "polars": lambda: rows.filter(pl.col("carrier") == "UA").height},
     "sum distance where origin=JFK": {"list": lambda: sum(r["distance"] for r in rows if r["origin"] == "JFK"), "packmem": lambda: rows.sum("distance", origin="JFK"),
        "polars": lambda: psum(rows.filter(pl.col("origin") == "JFK"), "distance")},
     "group count by dest": {"list": lambda: C(r["dest"] for r in rows)["ORD"], "packmem": lambda: rows.group_count("dest")["ORD"],
        "polars": lambda: rows.group_by("dest").len().filter(pl.col("dest") == "ORD")["len"][0]},
     "count dep_delay>60": {"list": lambda: sum(1 for r in rows if r["dep_delay"] is not None and r["dep_delay"] > 60), "packmem": lambda: rows.count(dep_delay__gt=60),
        "polars": lambda: rows.filter(pl.col("dep_delay") > 60).height},
     "sum air_time": {"list": lambda: sum(r["air_time"] for r in rows if r["air_time"] is not None), "packmem": lambda: rows.sum("air_time"),
        "polars": lambda: rows["air_time"].sum()},
     "10k random rows as dicts": {"list": lambda: sum(rows[i]["flight"] for i in idx), "packmem": lambda: sum(rows[i]["flight"] for i in idx),
        "polars": lambda: sum(rows.row(i, named=True)["flight"] for i in idx)},
     "loop over every row": {"list": lambda: sum(r["distance"] for r in rows), "packmem": lambda: sum(r["distance"] for r in rows),
        "polars": lambda: sum(r["distance"] for r in rows.iter_rows(named=True))},
    }
    loopcol = "distance"
elif base_ds == "nginx":
    Q = {
     "count response=404": {"list": lambda: sum(1 for r in rows if r["response"] == 404), "packmem": lambda: rows.count(response=404),
        "polars": lambda: rows.filter(pl.col("response") == 404).height},
     "sum bytes where agent contains Debian": {"list": lambda: sum(r["bytes"] for r in rows if "Debian" in r["agent"]), "packmem": lambda: rows.sum("bytes", agent__contains="Debian"),
        "polars": lambda: psum(rows.filter(contains("agent", "Debian")), "bytes")},
     "group count by remote_ip": {"list": lambda: len(C(r["remote_ip"] for r in rows)), "packmem": lambda: len(rows.group_count("remote_ip")),
        "polars": lambda: rows.group_by("remote_ip").len().height},
     "count request prefix": {"list": lambda: sum(1 for r in rows if r["request"].startswith("GET /downloads/product_2")), "packmem": lambda: rows.count(request__prefix="GET /downloads/product_2"),
        "polars": lambda: rows.filter(prefix("request", "GET /downloads/product_2")).height},
     "10k random rows as dicts": {"list": lambda: sum(rows[i]["bytes"] for i in idx), "packmem": lambda: sum(rows[i]["bytes"] for i in idx),
        "polars": lambda: sum(rows.row(i, named=True)["bytes"] for i in idx)},
     "loop over every row": {"list": lambda: sum(r["bytes"] for r in rows), "packmem": lambda: sum(r["bytes"] for r in rows),
        "polars": lambda: sum(r["bytes"] for r in rows.iter_rows(named=True))},
    }
    loopcol = "bytes"
else:
    Q = {
     "count status=404": {"list": lambda: sum(1 for r in rows if r["status"] == 404), "packmem": lambda: rows.count(status=404),
        "polars": lambda: rows.filter(pl.col("status") == 404).height},
     "sum bytes where ua contains curl": {"list": lambda: sum(r["bytes"] for r in rows if "curl" in r["ua"]), "packmem": lambda: rows.sum("bytes", ua__contains="curl"),
        "polars": lambda: psum(rows.filter(contains("ua", "curl")), "bytes")},
     "group count by ip": {"list": lambda: len(C(r["ip"] for r in rows)), "packmem": lambda: len(rows.group_count("ip")),
        "polars": lambda: rows.group_by("ip").len().height},
     "count path prefix /orders": {"list": lambda: sum(1 for r in rows if r["path"].startswith("/orders")), "packmem": lambda: rows.count(path__prefix="/orders"),
        "polars": lambda: rows.filter(prefix("path", "/orders")).height},
     "10k random rows as dicts": {"list": lambda: sum(rows[i]["bytes"] for i in idx), "packmem": lambda: sum(rows[i]["bytes"] for i in idx),
        "polars": lambda: sum(rows.row(i, named=True)["bytes"] for i in idx)},
     "loop over every row": {"list": lambda: sum(r["bytes"] for r in rows), "packmem": lambda: sum(r["bytes"] for r in rows),
        "polars": lambda: sum(r["bytes"] for r in rows.iter_rows(named=True))},
    }
    loopcol = "bytes"

out["q"] = {}
for name, impl in Q.items():
    ms, res = med(impl[kind], 3 if name.startswith("loop") else 5)
    out["q"][name] = [ms, res if not isinstance(res, float) else round(res, 3)]
if kind == "packmem":
    ms, res = med(lambda: sum(r[loopcol] for r in rows.lazy()), 3); out["q"]["loop over every row, lazy rows"] = [ms, res]
print(json.dumps(out))
