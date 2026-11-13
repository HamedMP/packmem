"""Median of each metric per configuration from run.py JSON lines."""
import json
import statistics
import sys
from collections import defaultdict

KEY = ("mode", "repo", "shard", "start_method", "pipeline", "fake_image")
METRICS = (
    "build_s",
    "main_maxrss_mb",
    "main_peak_footprint_mb",
    "footprint_after_build_mb",
    "pickle_mb",
    "pickle_dumps_s",
    "pickle_loads_s",
    "startup_to_first_batch_s",
    "iterate_s",
    "worker_peak_footprint_sum_mb",
)

groups = defaultdict(list)
for line in open(sys.argv[1]):
    d = json.loads(line)
    groups[tuple(d.get(k) for k in KEY)].append(d)

for key in sorted(groups, key=str):
    runs = groups[key]
    label = " ".join(f"{k}={v}" for k, v in zip(KEY, key) if v is not None)
    print(f"{label}  (runs={len(runs)})")
    for m in METRICS:
        vals = [r[m] for r in runs if r.get(m) is not None]
        if vals:
            print(f"    {m:30} median {statistics.median(vals):>10}   range {min(vals)}-{max(vals)}")
    per_worker = [max(r["worker_peak_footprint_mb"]) for r in runs if r.get("worker_peak_footprint_mb")]
    if per_worker:
        print(f"    {'max_single_worker_peak_mb':30} median {statistics.median(per_worker):>10}")
    loads = [r["loadavg"][0] for r in runs]
    print(f"    {'loadavg_1min':30} median {statistics.median(loads):>10.2f}   range {min(loads):.2f}-{max(loads):.2f}")
    shas = {r.get("batches_sha") for r in runs if r.get("batches_sha")}
    if shas:
        print(f"    batches_sha: {sorted(s[:16] for s in shas)}")
