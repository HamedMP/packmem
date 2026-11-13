"""Build qwen-vl-finetune's LazySupervisedDataset without a model and measure it.

v2 of harness/bench.py: same workload, plus spawn workers, per-worker peak memory and startup
times (wprobe), and a pickle mode. MB here is 1e6 bytes, as in v1.

usage: bench_v2.py TREE MODE DATASETS OUT_JSON
  TREE      checkout root containing qwen-vl-finetune/
  MODE      build | loader | verify | pickle
  env       MP_CTX=fork|spawn (loader), N_SAMPLES (default 20000)
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
import tempfile

tree, mode, datasets, out_path = sys.argv[1:5]
sys.path.insert(0, os.path.join(tree, "qwen-vl-finetune"))
sys.path.insert(1, os.path.dirname(os.path.abspath(__file__)))  # wprobe; -I leaves the script dir off sys.path

import psutil
import torch

import qwenvl.data as qd

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data")
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
import wprobe

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

    if mode == "pickle":
        import pickle
        dumps = []
        for _ in range(3):
            t0 = time.perf_counter()
            blob = pickle.dumps(ds)
            dumps.append(round(time.perf_counter() - t0, 3))
        t0 = time.perf_counter()
        back = pickle.loads(blob)  # our own bytes from the line above
        res.update(pickle_bytes=len(blob), pickle_mb=len(blob) / 1e6, dumps_s=dumps, loads_s=time.perf_counter() - t0)
        if hasattr(ds.list_data_dict, "nbytes"):
            res["table_nbytes_mb"] = ds.list_data_dict.nbytes / 1e6
        res["roundtrip_equal"] = len(back) == len(ds) and all(
            a == b for a, b in zip(back.list_data_dict, ds.list_data_dict))
        json.dump(res, open(out_path, "w"), indent=1)
        return

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
        os.environ["WPROBE_DIR"] = tempfile.mkdtemp(prefix="wprobe-")
        res["mp_ctx"] = os.environ.get("MP_CTX", "fork")
        dl = torch.utils.data.DataLoader(
            ds, batch_size=4, sampler=idx, num_workers=4,
            multiprocessing_context=res["mp_ctx"], collate_fn=wprobe.CollateProbe(collator), prefetch_factor=2,
            worker_init_fn=wprobe.worker_init,
        )
        t_iter = time.time()
        t0 = time.perf_counter()
        it = iter(dl)
        conc = 0
        n_batches = len(dl)
        for b, batch in enumerate(it):
            if b == 0:
                res["iter_to_first_batch_s"] = time.perf_counter() - t0
            last = time.perf_counter() - t0
            feed(batch)
            if b % 50 == 49:
                conc = max(conc, footprint(os.getpid()) + wprobe.current_sum())
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
        res["loader_s"] = time.perf_counter() - t0  # includes worker shutdown
        res["iter_to_last_batch_s"] = last
        res.update(wprobe.summary(t_iter))
        res["main_lifetime_peak_mib"] = wprobe.footprint()[1] / 2**20
        res["max_concurrent_total_mib"] = conc / 2**20
        res["main_peak_plus_worker_peaks_mib"] = res["main_lifetime_peak_mib"] + res["worker_peak_sum_mb"]  # wprobe reports MiB
    res["n_samples"] = len(idx)
    res["batches_sha256"] = h.hexdigest()
    json.dump(res, open(out_path, "w"), indent=1)


if __name__ == "__main__":
    main()
