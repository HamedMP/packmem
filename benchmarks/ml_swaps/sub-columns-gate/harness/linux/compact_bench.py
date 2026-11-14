"""hint="compact" vs default on the real LLaVA mix. One mode per fresh process.

usage: compact_bench.py <json> <hint> <out.json> [mode]
  mode = build (default) | verify | workers
"""
import gc, hashlib, json, multiprocessing as mp, os, random, resource, sys, time

import packmem


def smaps():
    out = {}
    with open("/proc/self/smaps_rollup") as f:
        for line in f:
            k, _, rest = line.partition(":")
            if k in ("Rss", "Pss", "Pss_Anon", "Private_Clean", "Private_Dirty", "Shared_Clean", "Shared_Dirty"):
                out[k] = int(rest.split()[0]) / 1024
    out["USS"] = out.get("Private_Clean", 0) + out.get("Private_Dirty", 0)
    return {k: round(v, 1) for k, v in out.items()}


def maxrss_mb():
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)


def words_lengths(rows):
    words = rows.col("conversations").list.field("value").str.split().list.len().list.sum()
    img = rows.col("image").notna()
    return [int(w) + (128 if i else 0) for w, i in zip(words, img)]


def build(path, hint, out):
    r = {"hint": hint, "zstd_level": os.environ.get("PACKMEM_ZSTD_LEVEL", "default"), "packmem": packmem.__version__,
         "load_start": os.getloadavg()}
    t0 = time.perf_counter(); rows = packmem.load_json(path, hint=hint); r["build_s"] = round(time.perf_counter() - t0, 2)
    r["maxrss_after_build_mb"] = maxrss_mb(); r["smaps_after_build"] = smaps()
    try:
        rows._t.release_freed_memory(); time.sleep(5); r["smaps_after_release"] = smaps()
    except AttributeError:
        r["smaps_after_release"] = "release_freed_memory missing"
    r["n"] = len(rows); r["nbytes"] = rows.nbytes
    desc = rows.describe(); desc = desc if isinstance(desc, str) else json.dumps(desc, default=str)
    r["describe"] = desc[:4000]; r["zstd_in_describe"] = "+zstd" in desc
    rng = random.Random(1); idx = [rng.randrange(len(rows)) for _ in range(100_000)]
    t0 = time.perf_counter()
    for i in idx: rows[i]
    r["random_row_us"] = round((time.perf_counter() - t0) / len(idx) * 1e6, 2)
    t0 = time.perf_counter(); n = 0
    for row in rows: n += len(row["conversations"])
    r["full_pass_s"] = round(time.perf_counter() - t0, 2)
    t0 = time.perf_counter(); L = words_lengths(rows); r["lengths_colops_s"] = round(time.perf_counter() - t0, 2)
    r["lengths_sha"] = hashlib.sha256(json.dumps(L).encode()).hexdigest()[:16]
    p = os.path.join(os.path.dirname(out), f"saved_{os.getpid()}.pkm")
    t0 = time.perf_counter(); rows.save(p); r["save_s"] = round(time.perf_counter() - t0, 2); r["saved_bytes"] = os.path.getsize(p)
    t0 = time.perf_counter(); o = packmem.open(p); r["open_ms"] = round((time.perf_counter() - t0) * 1e3, 1)
    t0 = time.perf_counter(); rows.share(); r["share_s"] = round(time.perf_counter() - t0, 2)
    del o; os.remove(p)
    r["load_end"] = os.getloadavg()
    json.dump(r, open(out, "w"), indent=1)


def _worker(args):
    p, seed = args
    t = packmem.open(p); base = smaps()
    rng = random.Random(seed)
    for _ in range(5000): t[rng.randrange(len(t))]
    return {"after_open": base, "after_5k_rows": smaps()}


def workers(path, hint, out):
    rows = packmem.load_json(path, hint=hint)
    p = os.path.join(os.path.dirname(out), f"w_{os.getpid()}.pkm"); rows.save(p); del rows; gc.collect()
    ctx = mp.get_context("spawn")
    with ctx.Pool(4) as pool:
        res = pool.map(_worker, [(p, s) for s in range(4)])
    os.remove(p)
    json.dump({"hint": hint, "zstd_level": os.environ.get("PACKMEM_ZSTD_LEVEL", "default"), "workers": res,
               "load": os.getloadavg()}, open(out, "w"), indent=1)


def verify(path, hint, out):
    ref = json.load(open(path))
    rows = packmem.load_json(path, hint=hint)
    bad = sum(1 for a, b in zip(rows, ref) if a != b)
    h = hashlib.sha256()
    for chunk in rows.iter_json() if hasattr(rows, "iter_json") else [rows.to_json()]:
        h.update(chunk if isinstance(chunk, bytes) else chunk.encode())
    json.dump({"hint": hint, "n": len(rows), "n_ref": len(ref), "rows_not_equal": bad,
               "to_json_sha": h.hexdigest()[:16]}, open(out, "w"), indent=1)


if __name__ == "__main__":
    path, hint, out = sys.argv[1:4]; mode = sys.argv[4] if len(sys.argv) > 4 else "build"
    {"build": build, "workers": workers, "verify": verify}[mode](path, hint, out)
