"""harness/run.py, restructured so DataLoader workers can use spawn as well as fork.

Builds MiniCPM-V's train dataset via finetune.make_supervised_data_module and reads N random
samples (same indices as run.py) through a DataLoader. Prints one JSON line with timings,
per-process memory and a SHA-256 of every tensor produced. Same workload and stubs as run.py.
"""
import argparse, gc, hashlib, json, os, random, sys, tempfile, time

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--data", required=True)
ap.add_argument("--n", type=int, default=20000)
ap.add_argument("--workers", type=int, default=0)
ap.add_argument("--batch", type=int, default=8)
ap.add_argument("--mp-context", default="fork")
ap.add_argument("--pickle", action="store_true", help="only measure pickle.dumps/loads of the dataset")


def main():
    args = ap.parse_args()
    sys.path.insert(0, os.path.join(args.repo, "finetune"))
    os.environ["WPROBE_DIR"] = tempfile.mkdtemp(prefix="wprobe-")
    import torch
    from torchvision import transforms
    import finetune as ft
    import dataset as ds
    import mstubs, wprobe
    mstubs.install()

    t0 = time.perf_counter()
    mod = ft.make_supervised_data_module(
        tokenizer=mstubs.StubTokenizer(),
        data_args=__import__("types").SimpleNamespace(data_path=args.data, eval_data_path=None),
        transform=transforms.ToTensor(),
        data_collator=ds.data_collator,
        llm_type="qwen",
        slice_config={"patch_size": 14, "max_slice_nums": 9, "scale_resolution": 448},
        patch_size=14,
        query_nums=64,
        batch_vision=True,
        max_length=2048,
    )
    train = mod["train_dataset"]
    gc.collect()
    res = {"records": len(train), "type": type(train.raw_data).__name__, "load_s": round(time.perf_counter() - t0, 3),
           "footprint_after_load_mb": round(wprobe.footprint()[0] / 2**20, 1)}

    if args.pickle:
        import pickle
        dumps = []
        for _ in range(3):
            t = time.perf_counter()
            blob = pickle.dumps(train)
            dumps.append(round(time.perf_counter() - t, 3))
        t = time.perf_counter()
        back = pickle.loads(blob)
        res.update(pickle_bytes=len(blob), pickle_mb=round(len(blob) / 2**20, 1), dumps_s=dumps,
                   loads_s=round(time.perf_counter() - t, 3))
        if hasattr(train.raw_data, "nbytes"):
            res["table_nbytes_mb"] = round(train.raw_data.nbytes / 2**20, 1)
        t = time.perf_counter()
        res["roundtrip_equal"] = len(back.raw_data) == len(train.raw_data) and all(
            a == b for a, b in zip(back.raw_data, train.raw_data))
        res["compare_s"] = round(time.perf_counter() - t, 3)
        print(json.dumps(res))
        return

    g = torch.Generator().manual_seed(0)
    idx = torch.randperm(len(train), generator=g)[: args.n].tolist()
    torch.manual_seed(0)
    random.seed(0)
    dl = torch.utils.data.DataLoader(
        train, batch_size=args.batch, sampler=idx, num_workers=args.workers,
        collate_fn=wprobe.CollateProbe(mod["data_collator"]), worker_init_fn=mstubs.worker_init,
        multiprocessing_context=args.mp_context if args.workers else None,
    )
    h = hashlib.sha256()
    peak_concurrent = 0
    t_iter = time.time()
    t1 = time.perf_counter()
    first = None
    for b, batch in enumerate(dl):
        if first is None:
            first = time.perf_counter() - t1
        last = time.perf_counter() - t1
        for k in ("input_ids", "position_ids", "labels", "attention_mask"):
            h.update(batch[k].numpy().tobytes())
        for sample in batch["pixel_values"]:
            for t in sample:
                h.update(t.numpy().tobytes())
        for bound in batch["image_bound"]:
            h.update(bound.numpy().tobytes() if torch.is_tensor(bound) else b"[]")
        for ts in batch["tgt_sizes"]:
            h.update(ts.numpy().tobytes() if torch.is_tensor(ts) else b"[]")
        if b % 50 == 49:
            peak_concurrent = max(peak_concurrent, wprobe.footprint()[0] + (wprobe.current_sum() if args.workers else 0))
    res["iter_s"] = round(time.perf_counter() - t1, 3)  # includes worker shutdown after the last batch
    res["iter_to_last_batch_s"] = round(last, 3)
    res["iter_to_first_batch_s"] = round(first, 3)
    main_cur, main_peak = wprobe.footprint()
    res["main_footprint_end_mb"] = round(main_cur / 2**20, 1)
    res["main_lifetime_peak_mb"] = round(main_peak / 2**20, 1)
    res["max_concurrent_total_mb"] = round(max(peak_concurrent, main_cur) / 2**20, 1)
    if args.workers:
        res.update(wprobe.summary(t_iter))
        res["main_peak_plus_worker_peaks_mb"] = round(res["main_lifetime_peak_mb"] + res["worker_peak_sum_mb"], 1)
    res["sha256"] = h.hexdigest()
    print(json.dumps(res))
    import shutil
    shutil.rmtree(os.environ["WPROBE_DIR"], ignore_errors=True)


if __name__ == "__main__":
    main()
