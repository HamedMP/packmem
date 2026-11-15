import sys, time, statistics as st, json, gc, packmem
t = packmem.load_json(sys.argv[1])
ts = []
for _ in range(5):
    a = time.perf_counter(); r = t.col("conversations").list.len(); ts.append(time.perf_counter() - a)
del r
n = len(t)
gc.collect()
a = time.perf_counter(); del t; gc.collect(); d = time.perf_counter() - a
print(json.dumps({"build": sys.argv[2], "query": "col(\"conversations\").list.len()", "times_s": [round(x, 4) for x in ts], "median_s": round(st.median(ts), 4), "del_t_s": round(d, 4), "rows": n}))
