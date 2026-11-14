"""After-build memory breakdown on Linux: Table.nbytes, smaps_rollup (PSS/USS/Pss_Anon/Private_Dirty), glibc
mallinfo2 (in use vs freed-but-held in arenas), VmHWM/ru_maxrss, and (REUSE_MB) whether later allocations reuse it.

usage: memcheck_linux.py qwen TREE OUT_JSON     (Qwen3-VL LazySupervisedDataset via bench_v3.build, llava665k)
       memcheck_linux.py llava TREE OUT_JSON    (LLaVA-NeXT ProbeDataset from data/mix.yaml)
"""
import json, os, random, sys, time

D = os.path.expanduser("~/packmem-subcol")
kind, tree, out = sys.argv[1:4]
sys.path.insert(0, os.path.join(D, "harness", "v3"))
import memlinux  # noqa: E402

if kind == "qwen":
    sys.argv = [sys.argv[0], tree, "build", "llava665k", out]
    import bench_v3  # reads its arguments at import time
    ds, build_s = bench_v3.build()
else:
    sys.path.insert(0, tree)
    sys.path.insert(1, os.path.join(D, "llava-next", "harness", "v2"))
    import llava_ds
    random.seed(0)
    t0 = time.perf_counter()
    ds = llava_ds.ProbeDataset(os.path.join(D, "llava-next", "data", "mix.yaml"), tokenizer=None, data_args=llava_ds.data_args())
    build_s = time.perf_counter() - t0
t = ds.list_data_dict
pm = sys.modules.get("packmem")
res = {"kind": kind, "tree": tree, "packmem": getattr(pm, "__version__", None), "build_s": round(build_s, 2),
       "rows": len(t), "nbytes": getattr(t, "nbytes", None), "after_build": memlinux.snap()}
res["reuse"] = memlinux.reuse()
json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res))
