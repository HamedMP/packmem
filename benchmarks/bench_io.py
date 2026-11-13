"""csv.DictReader and sqlite3 one-line swaps on the real flights data. One variant per process."""
import csv, gc, json, resource, sqlite3, sys, time
variant = sys.argv[1]
import mem
rss = mem.resident
if "packmem" in variant: import packmem
gc.collect(); base = rss(); fbase = mem.footprint(); t0 = time.perf_counter()
if variant == "csv_list":      rows = list(csv.DictReader(open("flights.csv", newline="")))
elif variant == "csv_packmem": rows = packmem.read_csv("flights.csv")
elif variant == "csv_packmem_wrap": rows = packmem.Table(csv.DictReader(open("flights.csv", newline="")))
else:
    con = sqlite3.connect("flights.db"); con.row_factory = sqlite3.Row
    if variant == "sqlite_list":      rows = [dict(r) for r in con.execute("select * from flights")]
    elif variant == "sqlite_packmem": rows = packmem.Table(con.execute("select * from flights"))
load = time.perf_counter() - t0; gc.collect()
t1 = time.perf_counter()
if "packmem" in variant: c = rows.count(origin="JFK"); g = rows.group_count("carrier")["DL"]
else: c = sum(1 for r in rows if r["origin"] == "JFK"); g = sum(1 for r in rows if r["carrier"] == "DL")
q = (time.perf_counter() - t1) * 1e3
import hashlib; sample = json.dumps([rows[0], rows[len(rows) // 2], rows[-1]], sort_keys=True)
print(json.dumps({"variant": variant, "rows": len(rows), "load_s": round(load, 2), "rss_mb": round(rss() - base, 1), "footprint_mb": round(mem.footprint() - fbase, 1), "peak_mb": round(mem.peak(), 1),
                  "two_queries_ms": round(q, 2), "answers": [c, g], "sample_md5": hashlib.md5(sample.encode()).hexdigest()[:8]}))
