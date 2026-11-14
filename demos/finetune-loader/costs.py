"""What the two memory-mapped options cost outside the workers' private data, saved to results/costs.json.

    python costs.py

- The files each one maps: the Arrow cache `datasets` built and the table `packmem` saved, in the cache directory
  run.py uses. Memory-mapped pages are page cache: shared by every process on the machine, paid once.
- What importing each library costs a process, by itself: torch alone, torch with packmem, torch with datasets.
  Under spawn every worker is a fresh interpreter that imports what the dataset class needs, so this is paid per worker.
  macOS phys_footprint (from `footprint`), RSS elsewhere; median of fresh processes.
"""
import glob
import json
import os
import platform
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
PROBE = r"""
import importlib, os, re, subprocess, sys
for m in sys.argv[1].split(","):
    importlib.import_module(m)
if sys.platform == "darwin":
    out = subprocess.run(["footprint", "-p", str(os.getpid())], capture_output=True, text=True).stdout
    v, unit = re.search(r"phys_footprint:\s*([\d.]+)\s*(\w+)", out).groups()
    print(float(v) * {"KB": 1e-3, "MB": 1, "GB": 1e3}[unit])
else:
    import psutil
    print(psutil.Process().memory_info().rss / 1e6)
"""


def import_mb(modules, runs=5):
    return statistics.median(float(subprocess.run([sys.executable, "-I", "-c", PROBE, modules], capture_output=True, text=True, check=True).stdout) for _ in range(runs))


def main():
    arrow = sum(os.path.getsize(p) for p in glob.glob(os.path.join(CACHE, "json", "**", "*.arrow"), recursive=True))
    pkm = sum(os.path.getsize(p) for p in glob.glob(os.path.join(CACHE, "*.pkm")))
    base = import_mb("torch")
    out = {
        "mapped_file_mb": {"datasets_arrow_cache": arrow / 1e6, "packmem_saved_table": pkm / 1e6},
        "import_mb": {"torch": base, "torch+packmem": import_mb("torch,packmem"), "torch+datasets": import_mb("torch,datasets")},
        "versions": {m: __import__(m).__version__ for m in ("torch", "packmem", "datasets")},
        "machine": {"platform": sys.platform, "machine": platform.machine()},
        "metric": "phys_footprint" if sys.platform == "darwin" else "rss",
        "loadavg_at_start": os.getloadavg()[0],
    }
    out["import_extra_mb"] = {k: v - base for k, v in out["import_mb"].items() if k != "torch"}
    with open(os.path.join(HERE, "results", "costs.json"), "w") as f:
        json.dump(out, f, indent=2)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
