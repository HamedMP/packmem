"""Build LazySupervisedDataset from a data YAML and report timings plus output hashes.

usage: bench.py <repo_dir> <data_path> <out_json> [--hash]
"""
import hashlib
import json
import os
import random
import sys
import time
from types import SimpleNamespace

repo, data_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
do_hash = "--hash" in sys.argv
sys.path.insert(0, repo)
sys.path.insert(1, os.path.dirname(os.path.abspath(__file__)))

import psutil
import llava_import

t = llava_import.load_train_module()
assert t.__file__.startswith(os.path.realpath(repo)) or t.__file__.startswith(repo), t.__file__

proc = psutil.Process()
res = {"repo": repo, "module": t.__file__, "rss_before_load_mb": proc.memory_info().rss / 1e6}

random.seed(0)
data_args = SimpleNamespace(early_mix_text=False)
t0 = time.perf_counter()
ds = t.LazySupervisedDataset(data_path, tokenizer=None, data_args=data_args)
res["load_s"] = time.perf_counter() - t0
res["n"] = len(ds)
res["container"] = type(ds.list_data_dict).__name__
res["rss_after_load_mb"] = proc.memory_info().rss / 1e6

t0 = time.perf_counter()
lengths = ds.lengths
res["lengths_s"] = time.perf_counter() - t0
t0 = time.perf_counter()
mlengths = ds.modality_lengths
res["modality_lengths_s"] = time.perf_counter() - t0

# The record lookups _get_item makes for one image sample: list_data_dict[i] for sources,
# "image" in ..., ["image"], has_image, the image branch of data_dict, and .get("id").
idx = random.Random(1).sample(range(len(ds)), 10000)
L = ds.list_data_dict
t0 = time.perf_counter()
for i in idx:
    src = [L[i]]
    if "image" in src[0]:
        _ = L[i]["image"]
    _ = ("image" in L[i]) or ("video" in L[i])
    _ = "image" in L[i]
    _ = L[i].get("id", i)
res["getitem_lookups_10k_s"] = time.perf_counter() - t0
res["rss_end_mb"] = proc.memory_info().rss / 1e6

h = lambda b: hashlib.sha256(b).hexdigest()
res["lengths_sha"] = h(json.dumps(lengths).encode())
res["modality_lengths_sha"] = h(json.dumps(mlengths).encode())
res["sample_ids_sha"] = h(json.dumps([[L[i].get("id", i), L[i]["conversations"]] for i in idx]).encode())
if do_hash:
    t0 = time.perf_counter()
    ordered, sorted_ = hashlib.sha256(), hashlib.sha256()
    for r in L:
        ordered.update(json.dumps(r).encode() + b"\n")
        sorted_.update(json.dumps(r, sort_keys=True).encode() + b"\n")
    res["rows_sha_key_order"] = ordered.hexdigest()
    res["rows_sha_sorted_keys"] = sorted_.hexdigest()
    res["hash_s"] = time.perf_counter() - t0

json.dump(res, open(out, "w"), indent=1)
print(json.dumps(res, indent=1))
