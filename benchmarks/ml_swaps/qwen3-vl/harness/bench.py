"""Build qwen-vl-finetune's LazySupervisedDataset without a model and measure it.

usage: bench.py TREE MODE DATASETS OUT_JSON
  TREE      checkout root containing qwen-vl-finetune/
  MODE      build | loader | verify
  DATASETS  comma list for --dataset_use, e.g. llava665k or llava665k%50,llava150k
"""
import gc
import hashlib
import json
import os
import random
import sys
import time
import zlib

tree, mode, datasets, out_path = sys.argv[1:5]
sys.path.insert(0, os.path.join(tree, "qwen-vl-finetune"))

import psutil
import torch

import qwenvl.data as qd

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
qd.data_dict["llava665k"] = {
    "annotation_path": os.path.join(DATA, "llava_v1_5_mix665k.json"),
    "data_path": "/datasets/llava/images",
}
qd.data_dict["llava665k_jsonl"] = {
    "annotation_path": os.path.join(DATA, "llava_v1_5_mix665k.jsonl"),
    "data_path": "/datasets/llava/images",
}
qd.data_dict["llava150k"] = {
    "annotation_path": os.path.join(DATA, "llava_instruct_150k_sub.json"),
    "data_path": "/datasets/coco",
}

from qwenvl.data import data_processor as dp
from qwenvl.train.argument import DataArguments


class StubTokenizer:
    pad_token_id = 151643
    model_max_length = 4096

    def decode(self, ids, skip_special_tokens=False):
        return " ".join(str(int(t)) for t in ids[:8])


class StubImageProcessor:
    min_pixels = max_pixels = 0
    merge_size = 2

    def __init__(self):
        self.size = {"shortest_edge": 0, "longest_edge": 0}


class StubProcessor:
    """Tokenizes text and media paths deterministically; no image decoding."""

    video_processor = None

    def __init__(self):
        self.image_processor = StubImageProcessor()
        self.tokenizer = StubTokenizer()

    def apply_chat_template(self, messages, tokenize, return_dict, return_tensors):
        ids = []
        for m in messages:
            ids += [151644, 77091 if m["role"] == "assistant" else 872, 198]
            for c in m["content"]:
                s = c.get("text") or c.get("image") or c.get("video")
                ids += [zlib.crc32(w.encode()) % 150000 for w in s.split()]
            ids += [151645, 198]
        t = torch.tensor([ids])
        return {"input_ids": t, "attention_mask": torch.ones_like(t)}


import ctypes

_libc = ctypes.CDLL("libc.dylib")


def footprint(pid):
    """phys_footprint from proc_pid_rusage (macOS): dirty private + compressed memory."""
    buf = (ctypes.c_uint64 * 40)()
    if _libc.proc_pid_rusage(pid, 2, ctypes.byref(buf)) != 0:
        return 0
    return buf[2 + 7]


def build():
    args = DataArguments(dataset_use=datasets, data_packing=os.environ.get("PACKING") == "1")
    args.model_type = "qwen2.5vl"
    random.seed(0)
    t0 = time.perf_counter()
    ds = dp.LazySupervisedDataset(StubProcessor(), args)
    t_build = time.perf_counter() - t0
    gc.collect()
    return ds, t_build


def main():
    res = {"tree": tree, "mode": mode, "datasets": datasets}
    ds, res["build_s"] = build()
    res["n"] = len(ds)
    res["rss_after_build_mb"] = psutil.Process().memory_info().rss / 1e6
    res["footprint_after_build_mb"] = footprint(os.getpid()) / 1e6
    h = hashlib.sha256()

    if mode == "verify":
        t0 = time.perf_counter()
        for i in range(len(ds)):
            h.update(json.dumps(ds.list_data_dict[i], sort_keys=True).encode())
            h.update(b"\n")
        res["rows_sha256"] = h.hexdigest()
        res["verify_s"] = time.perf_counter() - t0
        json.dump(res, open(out_path, "w"), indent=1)
        return

    t0 = time.perf_counter()
    lengths = ds.lengths
    res["lengths_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    mlengths = ds.modality_lengths
    res["modality_lengths_s"] = time.perf_counter() - t0
    res["lengths_sha256"] = hashlib.sha256(json.dumps([lengths, mlengths]).encode()).hexdigest()
    del lengths, mlengths

    rng = random.Random(1)
    n_samples = int(os.environ.get("N_SAMPLES", "20000"))
    if n_samples >= len(ds):
        idx = list(range(len(ds)))
        rng.shuffle(idx)
    else:
        idx = [rng.randrange(len(ds)) for _ in range(n_samples)]
    collator = dp.DataCollatorForSupervisedDataset(tokenizer=StubTokenizer())

    def feed(batch):
        for k in ("input_ids", "labels", "position_ids"):
            h.update(batch[k].numpy().tobytes())

    if mode == "build":
        t0 = time.perf_counter()
        items = []
        for i in idx:
            items.append(ds[i])
            if len(items) == 4:
                feed(collator(items))
                items = []
        res["getitem_s"] = time.perf_counter() - t0
    elif mode == "loader":
        dl = torch.utils.data.DataLoader(
            ds, batch_size=4, sampler=idx, num_workers=4,
            multiprocessing_context="fork", collate_fn=collator, prefetch_factor=2,
        )
        t0 = time.perf_counter()
        it = iter(dl)
        n_batches = len(dl)
        for b, batch in enumerate(it):
            feed(batch)
            if b in (int(n_batches * 0.1), int(n_batches * 0.5)):
                pids = [w.pid for w in it._workers]
                res.setdefault("worker_footprint_checkpoints_mb", []).append(
                    (round(b / n_batches, 2), [round(footprint(p) / 1e6) for p in pids])
                )
            if b == int(n_batches * 0.9):
                pids = [w.pid for w in it._workers]
                res["worker_footprint_mb"] = [footprint(p) / 1e6 for p in pids]
                res["worker_rss_mb"] = [psutil.Process(p).memory_info().rss / 1e6 for p in pids]
                res["main_footprint_at_90pct_mb"] = footprint(os.getpid()) / 1e6
                res["main_rss_at_90pct_mb"] = psutil.Process().memory_info().rss / 1e6
                res["total_footprint_mb"] = res["main_footprint_at_90pct_mb"] + sum(res["worker_footprint_mb"])
        res["loader_s"] = time.perf_counter() - t0
    res["n_samples"] = len(idx)
    res["batches_sha256"] = h.hexdigest()
    json.dump(res, open(out_path, "w"), indent=1)


main()
