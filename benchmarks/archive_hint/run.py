"""One arm of the archive-hint benchmark; writes one raw JSON result.
usage: run.py <data.jsonl> <result.json> <arm> [commit]
arm compact | archive: packmem.load_jsonl(hint=arm, threads=1, keep_key_order=True); bytes of to_bytes(), build time,
  median of 3,000 random-row reads, one full scan, peak RSS, and a check that every row re-serialises to its input line.
arm zstd19: zstd level 19 of the whole file in one frame (the JSONL compressed as a file), with compress time."""
import json, os, platform, random, resource, statistics, sys, time

data, out, arm = sys.argv[1], sys.argv[2], sys.argv[3]
commit = sys.argv[4] if len(sys.argv) > 4 else None
raw = os.path.getsize(data)
rows = sum(1 for _ in open(data, "rb"))
cpu = next((l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name")), platform.processor()) if os.path.exists("/proc/cpuinfo") else platform.processor()
res = {"arm": arm, "commit": commit, "data": {"bytes": raw, "rows": rows, "generator": "nested_gen.py data.jsonl 200000"},
       "env": {"python": platform.python_version(), "platform": f"{sys.platform}-{platform.machine()}", "cpu": cpu, "load_start": [round(x, 2) for x in os.getloadavg()]}}
if arm == "zstd19":
    import zstandard as zstd
    buf = open(data, "rb").read()
    t = time.perf_counter(); n = len(zstd.ZstdCompressor(level=19).compress(buf)); res["compress_s"] = round(time.perf_counter() - t, 1)
    res["bytes"] = n
else:
    import packmem
    res["packmem"] = packmem.__version__
    res["options"] = {"hint": arm, "threads": 1, "keep_key_order": True}
    t = time.perf_counter(); tb = packmem.load_jsonl(data, hint=arm, threads=1, keep_key_order=True); res["build_s"] = round(time.perf_counter() - t, 1)
    res["bytes"] = len(tb.to_bytes())
    rnd = random.Random(0); ts = []
    for _ in range(3000):
        i = rnd.randrange(len(tb)); t0 = time.perf_counter(); tb[i]; ts.append(time.perf_counter() - t0)
    res["row_read_median_us"] = round(statistics.median(ts) * 1e6, 1)
    t = time.perf_counter(); n = sum(1 for _ in tb); res["full_scan_s"] = round(time.perf_counter() - t, 2)
    dumps = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    res["rows_reproducing_their_line"] = sum(dumps(r) == line.rstrip("\n") for r, line in zip(tb, open(data, encoding="utf-8")))
res["max_rss_bytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
res["env"]["load_end"] = [round(x, 2) for x in os.getloadavg()]
json.dump(res, open(out, "w"), indent=1); open(out, "a").write("\n")
print(json.dumps(res))
