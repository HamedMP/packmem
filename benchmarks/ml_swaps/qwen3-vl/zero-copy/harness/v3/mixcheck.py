"""Is the mixed-path footprint (llava665k%50,llava150k) packed size or allocator retention?

usage: mixcheck.py steps DATA_DIR OUT_JSON      the v3 patch's steps by hand, nbytes/footprint/malloc after each
       mixcheck.py repo TREE DATA_DIR OUT_JSON  the repository's LazySupervisedDataset, as bench_v3 builds it
malloc in-use = malloc_zone_statistics(NULL) size_in_use (all zones). MB = 1e6 bytes.
"""
import ctypes, gc, json, os, random, sys

_libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")


class _MStats(ctypes.Structure):
    _fields_ = [("blocks_in_use", ctypes.c_uint), ("size_in_use", ctypes.c_size_t),
                ("max_size_in_use", ctypes.c_size_t), ("size_allocated", ctypes.c_size_t)]


def snap(t=None):
    gc.collect()
    buf = (ctypes.c_uint64 * 64)()
    _libc.proc_pid_rusage(os.getpid(), 4, buf)
    st = _MStats()
    _libc.malloc_zone_statistics(None, ctypes.byref(st))
    d = {"footprint_mb": round(buf[2 + 7] / 1e6, 1), "peak_mb": round(buf[2 + 28] / 1e6, 1),
         "malloc_in_use_mb": round(st.size_in_use / 1e6, 1), "malloc_allocated_mb": round(st.size_allocated / 1e6, 1)}
    if t is not None:
        d.update(rows=len(t), nbytes_mb=round(t.nbytes / 1e6, 1), chunks=chunks(t))
    return d


def tools(out):
    import subprocess
    for tool, cmd in (("footprint", ["footprint", "-p", str(os.getpid())]), ("vmmap", ["vmmap", "-summary", str(os.getpid())])):
        with open(f"{out}.{tool}.txt", "w") as f:
            subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)


def chunks(t):
    for name in ("chunks", "n_chunks", "chunk_count"):
        v = getattr(t._t, name, None)
        if v is not None:
            return v() if callable(v) else v
    return None


def steps(data, out):
    import packmem
    res = {"packmem": packmem.__version__, "start": snap()}
    random.seed(0)
    a = packmem.load_json(os.path.join(data, "llava_v1_5_mix665k.json"))
    res["load_665k"] = snap(a)
    k = int(len(a) * 0.5)
    a = a.take(random.sample(range(len(a)), k))
    res["take_50pct"] = snap(a)
    a.set_column("data_path", "/datasets/llava/images")
    res["set_column_a"] = snap(a)
    b = packmem.load_json(os.path.join(data, "llava_instruct_150k_sub.json"))
    res["load_150k"] = snap(b)
    b.set_column("data_path", "/datasets/coco")
    a.extend(b)
    del b
    res["extend"] = snap(a)
    rows = list(a)
    ref = packmem.Table(rows)
    del rows
    res["repacked_from_dicts"] = snap(ref)
    res["repacked_equal"] = ref == a
    del ref
    c = a.copy()
    res["copy_of_final"] = snap(c)
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps(res, indent=1))


def repo(tree, data, out):
    # bench_v3 reads its arguments at import time and registers the datasets under ../../data
    sys.argv = [sys.argv[0], tree, "build", os.environ.get("MIX_DATASETS", "llava665k%50,llava150k"), out]
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import bench_v3
    ds, build_s = bench_v3.build()
    t = ds.list_data_dict
    res = {"tree": tree, "build_s": round(build_s, 2), "built": snap(t), "packmem": sys.modules["packmem"].__version__,
           "packmem_file": sys.modules["packmem"].__file__, "threads": os.environ.get("PACKMEM_LOAD_THREADS")}
    if os.environ.get("VMMAP") == "1":
        tools(out)
        import memprobe
        res["reuse"] = memprobe.reuse(out)
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    if sys.argv[1] == "steps":
        steps(sys.argv[2], sys.argv[3])
    else:
        repo(sys.argv[2], sys.argv[3], sys.argv[4])
