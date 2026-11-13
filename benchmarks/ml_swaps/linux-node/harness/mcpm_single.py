"""Per-record sha256 of json.dumps(row, sort_keys=True) for MiniCPM-V's train dataset. env TREE, DATA.

usage: mcpm_single.py OUT_PREFIX  -> OUT_PREFIX.digests, OUT_PREFIX.json
"""
import hashlib
import json
import os
import sys
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.environ["TREE"], "finetune"))
from torchvision import transforms
import finetune as ft
import dataset as ds
import mstubs

t0 = time.perf_counter()
mod = ft.make_supervised_data_module(
    tokenizer=mstubs.StubTokenizer(),
    data_args=types.SimpleNamespace(data_path=os.environ["DATA"], eval_data_path=None),
    transform=transforms.ToTensor(), data_collator=ds.data_collator, llm_type="qwen",
    slice_config={"patch_size": 14, "max_slice_nums": 9, "scale_resolution": 448},
    patch_size=14, query_nums=64, batch_vision=True, max_length=2048,
)
raw = mod["train_dataset"].raw_data
res = {"tree": os.environ["TREE"], "build_s": time.perf_counter() - t0, "n": len(raw), "container": type(raw).__name__}
whole = hashlib.sha256()
with open(sys.argv[1] + ".digests", "wb") as f:
    for i in range(len(raw)):
        d = hashlib.sha256(json.dumps(raw[i], sort_keys=True).encode()).digest()
        f.write(d)
        whole.update(d)
res["rows_sha256"] = whole.hexdigest()
json.dump(res, open(sys.argv[1] + ".json", "w"), indent=1)
print(json.dumps(res))
