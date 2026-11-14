"""Diagnostics requested by the core session. One mode per fresh process; prints one JSON line.

  diag.py threads <file>            load with a sampler thread: peak RssAnon/RssFile/Pss_Anon during the load
  diag.py pqshare <parquet>         read_parquet (or 0.2.0 batch extend), share(), then step-wise release
  diag.py nested <name>             describe() of the nested column and timing of field extraction vs to_list
"""
import gc, json, os, sys, threading, time

sys.path.insert(0, os.path.dirname(__file__))


def status():
    d = {}
    for line in open("/proc/self/status"):
        k, _, v = line.partition(":")
        if k in ("VmRSS", "RssAnon", "RssFile", "RssShmem", "VmHWM"):
            d[k] = int(v.split()[0]) / 1024
    return d


def rollup():
    d = {}
    for line in open("/proc/self/smaps_rollup"):
        k, _, v = line.partition(":")
        if k in ("Pss_Anon", "Private_Clean", "Private_Dirty"):
            d[k] = int(v.split()[0]) / 1024
    d["USS"] = d.get("Private_Clean", 0) + d.get("Private_Dirty", 0)
    return {k: round(v, 1) for k, v in d.items()}


def threads(path):
    import packmem
    peaks = {"RssAnon": 0.0, "RssFile": 0.0, "VmRSS": 0.0, "Pss_Anon": 0.0}
    done = threading.Event()

    def sample():
        while not done.is_set():
            s = status(); r = rollup()
            for k in ("RssAnon", "RssFile", "VmRSS"): peaks[k] = max(peaks[k], s.get(k, 0))
            peaks["Pss_Anon"] = max(peaks["Pss_Anon"], r.get("Pss_Anon", 0))
            time.sleep(0.02)
    base = {"status": status(), "rollup": rollup()}
    th = threading.Thread(target=sample, daemon=True); th.start()
    t0 = time.perf_counter()
    t = packmem.load_json(path) if path.endswith(".json") else packmem.load_jsonl(path)
    load_s = time.perf_counter() - t0
    done.set(); th.join()
    after = {"status": status(), "rollup": rollup()}
    time.sleep(5)
    settle = {"status": status(), "rollup": rollup()}
    return {"mode": "threads", "file": os.path.basename(path), "threads_env": os.environ.get("PACKMEM_THREADS", "default"),
            "packmem": packmem.__version__, "load_s": round(load_s, 3), "nbytes": t.nbytes,
            "base": base, "peak_during_load": {k: round(v, 1) for k, v in peaks.items()}, "after_load": after, "after_5s": settle}


def pqshare(path):
    import packmem, pyarrow as pa, pyarrow.parquet as pq
    steps = {"start": rollup()}
    if hasattr(packmem, "read_parquet"):
        how = "packmem.read_parquet"; t = packmem.read_parquet(path)
    else:
        how = "Table + extend(batch.to_pylist()) per 65536-row batch"
        t = packmem.Table()
        with pq.ParquetFile(path) as f:
            for b in f.iter_batches(batch_size=65536):
                t.extend(b.to_pylist())
            del b
    steps["after_load"] = rollup(); steps["pa_allocated_after_load_mb"] = round(pa.total_allocated_bytes() / 2**20, 1)
    t.share()
    steps["after_share"] = rollup(); steps["pa_allocated_after_share_mb"] = round(pa.total_allocated_bytes() / 2**20, 1)
    gc.collect(); steps["after_gc"] = rollup()
    pa.default_memory_pool().release_unused(); steps["after_pool_release"] = rollup()
    try:
        t._t.release_freed_memory(); steps["after_release_freed"] = rollup()
    except AttributeError:
        steps["after_release_freed"] = "release_freed_memory missing"
    steps["pa_allocated_end_mb"] = round(pa.total_allocated_bytes() / 2**20, 1)
    steps["pool_backend"] = pa.default_memory_pool().backend_name
    return {"mode": "pqshare", "packmem": packmem.__version__, "how": how, "nbytes": t.nbytes, "rows": len(t), "steps": steps}


def nested(name):
    import packmem, common
    p = common.src_path(name)
    t = packmem.load_jsonl(p)
    field = {"swe_smith": "messages", "swe_rebench": "trajectory", "mind2web": "actions", "agentnet": "traj"}[name]
    sub = {"swe_smith": "role", "swe_rebench": "role", "mind2web": "operation", "agentnet": "value"}[name]
    desc = t.describe()
    d = [x for x in desc if x[0] == field] if isinstance(desc, list) else desc
    out = {"mode": "nested", "packmem": packmem.__version__, "dataset": name, "field": field, "describe_field": json.dumps(d, default=str)[:3000]}
    c = t.col(field)
    t0 = time.perf_counter(); f = c.list.field(sub); out["field_expr_s"] = round(time.perf_counter() - t0, 3)
    t0 = time.perf_counter(); v = f.to_list(); out["to_list_s"] = round(time.perf_counter() - t0, 3)
    t0 = time.perf_counter(); n = c.list.len(); out["list_len_s"] = round(time.perf_counter() - t0, 3)
    t0 = time.perf_counter(); rows = [t[i] for i in range(min(len(t), 500))]; out["rows_500_s"] = round(time.perf_counter() - t0, 3)
    out["n_rows"] = len(t)
    return out


if __name__ == "__main__":
    mode = sys.argv[1]
    print(json.dumps({"threads": threads, "pqshare": pqshare, "nested": nested}[mode](sys.argv[2]), default=str))
