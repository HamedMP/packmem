"""One torchrun rank of qwen-vl-finetune's data pipeline, without a model.

Builds LazySupervisedDataset with the repo's own code and a stub processor, then reads this rank's
DistributedSampler shard through a DataLoader. env: TREE (checkout root), DATA (dir with the json),
OUT_DIR, PROBE_DIR. args: --samples samples per rank (0 = whole shard), --shards (sampler num_replicas),
--workers, --ctx fork|forkserver|spawn.
Module-level imports mirror a real training script, so forkserver/spawn preload them as they would.
"""
import argparse
import hashlib
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.environ["TREE"], "qwen-vl-finetune"))

import torch
import torch.distributed as dist
from torch.utils.data import DataLoader, DistributedSampler

import qwenvl.data as qd
from qwenvl.data import data_processor as dp
from qwenvl.train.argument import DataArguments
import qstubs

qd.data_dict["llava665k"] = {
    "annotation_path": os.path.join(os.environ["DATA"], "llava_v1_5_mix665k.json"),
    "data_path": "/datasets/llava/images",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=20000)
    ap.add_argument("--shards", type=int, default=8)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--ctx", default="fork")
    ap.add_argument("--batch", type=int, default=4)
    a = ap.parse_args()

    dist.init_process_group("gloo")
    rank = dist.get_rank()
    res = {"rank": rank, "pid": os.getpid(), "world": dist.get_world_size(), "shards": a.shards,
           "workers": a.workers, "ctx": a.ctx, "tree": os.environ["TREE"], "t_start": time.time()}

    args = DataArguments(dataset_use="llava665k", data_packing=False)
    args.model_type = "qwen2.5vl"
    random.seed(0)
    t0 = time.perf_counter()
    res["t_build_start"] = time.time()
    ds = dp.LazySupervisedDataset(qstubs.StubProcessor(), args)
    res["build_s"] = time.perf_counter() - t0
    res["t_build_end"] = time.time()
    res["n_records"] = len(ds)
    res["container"] = type(ds.list_data_dict).__name__
    dist.barrier()

    sampler = DistributedSampler(ds, num_replicas=a.shards, rank=rank, shuffle=True, seed=0)
    sampler.set_epoch(0)
    idx = list(iter(sampler))
    if a.samples:
        idx = idx[: a.samples]
    res["n_samples"] = len(idx)
    res["idx_sha256"] = hashlib.sha256(json.dumps(idx).encode()).hexdigest()
    collator = dp.DataCollatorForSupervisedDataset(tokenizer=qstubs.StubTokenizer())
    dl = DataLoader(
        ds, batch_size=a.batch, sampler=idx, num_workers=a.workers,
        multiprocessing_context=a.ctx if a.workers else None,
        collate_fn=qstubs.CollateProbe(collator), worker_init_fn=qstubs.worker_init,
        prefetch_factor=2 if a.workers else None,
    )
    hashes = {k: hashlib.sha256() for k in ("input_ids", "labels", "position_ids")}
    res["t_iter_start"] = time.time()
    t0 = time.perf_counter()
    for b, batch in enumerate(dl):
        if b == 0:
            res["iter_to_first_batch_s"] = time.perf_counter() - t0
            res["t_first_batch"] = time.time()
        for k, h in hashes.items():
            h.update(batch[k].numpy().tobytes())
    res["t_last_batch"] = time.time()
    res["loader_s"] = time.perf_counter() - t0
    res["n_batches"] = b + 1
    res.update({f"{k}_sha256": h.hexdigest() for k, h in hashes.items()})
    with open(os.path.join(os.environ["OUT_DIR"], f"rank{rank}.json"), "w") as f:
        json.dump(res, f, indent=1)
    dist.barrier()
    dist.destroy_process_group()


if __name__ == "__main__":
    main()
