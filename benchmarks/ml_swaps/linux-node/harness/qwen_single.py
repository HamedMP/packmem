"""Single process checks on qwen-vl-finetune's LazySupervisedDataset. env TREE, DATA.

usage: qwen_single.py verify OUT_PREFIX   per-record sha256 of json.dumps(row, sort_keys=True) -> OUT_PREFIX.digests
       qwen_single.py pickle OUT_JSON     pickle size and time of the whole dataset object
"""
import hashlib
import json
import os
import pickle
import random
import resource
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.environ["TREE"], "qwen-vl-finetune"))
import qwenvl.data as qd
from qwenvl.data import data_processor as dp
from qwenvl.train.argument import DataArguments
import qstubs

qd.data_dict["llava665k"] = {
    "annotation_path": os.path.join(os.environ["DATA"], "llava_v1_5_mix665k.json"),
    "data_path": "/datasets/llava/images",
}


def rss_mb():
    with open("/proc/self/status") as f:
        return next(int(l.split()[1]) for l in f if l.startswith("VmRSS")) / 1024


mode, out = sys.argv[1], sys.argv[2]
args = DataArguments(dataset_use="llava665k", data_packing=False)
args.model_type = "qwen2.5vl"
random.seed(0)
t0 = time.perf_counter()
ds = dp.LazySupervisedDataset(qstubs.StubProcessor(), args)
res = {"tree": os.environ["TREE"], "build_s": time.perf_counter() - t0, "n": len(ds),
       "container": type(ds.list_data_dict).__name__, "rss_after_build_mib": rss_mb()}

if mode == "verify":
    whole = hashlib.sha256()
    t0 = time.perf_counter()
    with open(out + ".digests", "wb") as f:
        for i in range(len(ds)):
            d = hashlib.sha256(json.dumps(ds.list_data_dict[i], sort_keys=True).encode()).digest()
            f.write(d)
            whole.update(d)
    res.update(verify_s=time.perf_counter() - t0, rows_sha256=whole.hexdigest())
    json.dump(res, open(out + ".json", "w"), indent=1)
elif mode == "pickle":
    dumps = []
    for _ in range(3):
        t0 = time.perf_counter()
        blob = pickle.dumps(ds, protocol=pickle.HIGHEST_PROTOCOL)
        dumps.append(round(time.perf_counter() - t0, 3))
    t0 = time.perf_counter()
    back = pickle.loads(blob)
    res.update(pickle_bytes=len(blob), dumps_s=dumps, loads_s=time.perf_counter() - t0)
    if hasattr(ds.list_data_dict, "nbytes"):
        res["table_nbytes"] = ds.list_data_dict.nbytes
    t0 = time.perf_counter()
    res["roundtrip_equal"] = len(back) == len(ds) and all(
        a == b for a, b in zip(back.list_data_dict, ds.list_data_dict))
    res["compare_s"] = time.perf_counter() - t0
    res["maxrss_mib"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res))
