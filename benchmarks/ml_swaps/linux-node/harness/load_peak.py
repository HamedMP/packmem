"""Peak and settled RSS of packmem.load_json on one file, in a fresh process. usage: load_peak.py PATH"""
import gc, json, resource, sys, time
import packmem
def rss():
    return next(int(l.split()[1]) for l in open("/proc/self/status") if l.startswith("VmRSS")) / 1024
r0 = rss(); t0 = time.perf_counter()
t = packmem.load_json(sys.argv[1])
dt = time.perf_counter() - t0
gc.collect()
print(json.dumps({"packmem": packmem.__version__, "rows": len(t), "nbytes": t.nbytes, "load_s": round(dt, 2),
  "rss_before_mib": round(r0), "rss_after_mib": round(rss()), "peak_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
  "load": open("/proc/loadavg").read().split()[:3]}))
