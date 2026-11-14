"""import_cost.py: per-process import cost, reproducing demos/finetune-loader/costs.py (main) on Linux.

Each probe is a fresh `python -I` that imports the listed modules and reports psutil RSS (costs.py's Linux metric) plus
PSS / USS / Pss_Anon from /proc/self/smaps_rollup. Median of 5 fresh processes per probe."""
import json
import os
import statistics
import subprocess
import sys

PROBE = r"""
import importlib, json, sys
for m in filter(None, sys.argv[1].split(",")):
    importlib.import_module(m)
import psutil
d = {}
for line in open("/proc/self/smaps_rollup"):
    p = line.split()
    if len(p) == 3 and p[2] == "kB":
        d[p[0].rstrip(":")] = int(p[1]) * 1024
print(json.dumps({"rss": psutil.Process().memory_info().rss, "Pss": d["Pss"], "USS": d["Private_Clean"] + d["Private_Dirty"],
                  "Pss_Anon": d["Pss_Anon"], "Private_Dirty": d["Private_Dirty"]}))
"""
PROBES = ["", "packmem", "datasets", "pyarrow", "torch", "torch,packmem", "torch,datasets", "torch,pyarrow"]


def probe(mods, runs=5):
    rs = [json.loads(subprocess.run([sys.executable, "-I", "-c", PROBE, mods], capture_output=True, text=True, check=True).stdout)
          for _ in range(runs)]
    return {k: statistics.median(r[k] for r in rs) / 1e6 for k in rs[0]}


out = {"loadavg_at_start": os.getloadavg()[0], "import_mb": {}}
for m in PROBES:
    out["import_mb"][m or "(bare python)"] = probe(m)
base = out["import_mb"]["torch"]
out["extra_over_torch_mb"] = {k: {m: v[m] - base[m] for m in v} for k, v in out["import_mb"].items() if k.startswith("torch,")}
bare = out["import_mb"]["(bare python)"]
out["extra_over_bare_mb"] = {k: {m: v[m] - bare[m] for m in v} for k, v in out["import_mb"].items() if "," not in k and k != "(bare python)"}
out["versions"] = {m: __import__(m).__version__ for m in ("torch", "packmem", "datasets", "pyarrow")}
out["loadavg_at_end"] = os.getloadavg()[0]
print(json.dumps(out))
