import json,sys,time
recs=[json.loads(l) for l in open(sys.argv[1])]
def med(f):
    ts=[]
    for _ in range(5):
        t=time.perf_counter(); r=f(); ts.append((time.perf_counter()-t)*1e3)
    return sorted(ts)[2], r
print("python Q1", med(lambda: sum(r["bytes"] for r in recs if r["status"]==404)))
print("python Q3", med(lambda: sum(1 for r in recs if "curl" in r["ua"])))
print("python Q7", med(lambda: sum(r["latency_us"] for r in recs)))
