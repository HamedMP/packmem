"""Build LLaVA-NeXT's LazySupervisedDataset (llava_ds.ProbeDataset) from a data YAML, compute
lengths and modality_lengths as the length-grouped sampler does, then read 20,000 seeded random
indices through a DataLoader with the repository's collator. One JSON line: timings, memory per
process, SHA-256 of every collated tensor. MB = MiB here.

usage: run_v2.py REPO DATA_PATH [--workers N] [--mp-context fork|spawn] [--pickle]
"""
import argparse, gc, hashlib, json, os, random, sys, tempfile, time

ap = argparse.ArgumentParser()
ap.add_argument("repo")
ap.add_argument("data_path")
ap.add_argument("--n", type=int, default=20000)
ap.add_argument("--workers", type=int, default=0)
ap.add_argument("--batch", type=int, default=4)
ap.add_argument("--mp-context", default="fork")
ap.add_argument("--pickle", action="store_true")


def main():
    args = ap.parse_args()
    sys.path.insert(0, args.repo)
    sys.path.insert(1, os.path.dirname(os.path.abspath(__file__)))
    os.environ["WPROBE_DIR"] = tempfile.mkdtemp(prefix="wprobe-")
    import torch
    import llava_ds, wprobe
    assert llava_ds.t.__file__.startswith(args.repo), llava_ds.t.__file__

    random.seed(0)
    t0 = time.perf_counter()
    ds = llava_ds.ProbeDataset(args.data_path, tokenizer=None, data_args=llava_ds.data_args())
    res = {"records": len(ds), "type": type(ds.list_data_dict).__name__, "load_s": round(time.perf_counter() - t0, 3)}
    gc.collect()
    res["footprint_after_load_mb"] = round(wprobe.footprint()[0] / 2**20, 1)

    if args.pickle:
        import pickle
        dumps = []
        for _ in range(3):
            t1 = time.perf_counter()
            blob = pickle.dumps(ds)
            dumps.append(round(time.perf_counter() - t1, 3))
        t1 = time.perf_counter()
        back = pickle.loads(blob)  # our own bytes from the line above
        res.update(pickle_bytes=len(blob), pickle_mb=round(len(blob) / 2**20, 1), dumps_s=dumps,
                   loads_s=round(time.perf_counter() - t1, 3))
        if hasattr(ds.list_data_dict, "nbytes"):
            res["table_nbytes_mb"] = round(ds.list_data_dict.nbytes / 2**20, 1)
        res["roundtrip_equal"] = len(back.list_data_dict) == len(ds.list_data_dict) and all(
            a == b for a, b in zip(back.list_data_dict, ds.list_data_dict))
        print(json.dumps(res))
        return

    t1 = time.perf_counter()
    lengths = ds.lengths
    res["lengths_s"] = round(time.perf_counter() - t1, 3)
    t1 = time.perf_counter()
    mlengths = ds.modality_lengths
    res["modality_lengths_s"] = round(time.perf_counter() - t1, 3)
    res["lengths_sha"] = hashlib.sha256(json.dumps([lengths, mlengths]).encode()).hexdigest()
    del lengths, mlengths
    gc.collect()

    idx = random.Random(1).sample(range(len(ds)), args.n)
    torch.manual_seed(0)
    dl = torch.utils.data.DataLoader(
        ds, batch_size=args.batch, sampler=idx, num_workers=args.workers,
        collate_fn=wprobe.CollateProbe(llava_ds.collator()), worker_init_fn=wprobe.worker_init,
        multiprocessing_context=args.mp_context if args.workers else None,
    )
    h = hashlib.sha256()
    conc = 0
    t_iter = time.time()
    t1 = time.perf_counter()
    for b, batch in enumerate(dl):
        if b == 0:
            res["iter_to_first_batch_s"] = round(time.perf_counter() - t1, 3)
        last = time.perf_counter() - t1
        for k in ("input_ids", "labels", "attention_mask"):
            h.update(batch[k].numpy().tobytes())
        for im in batch["images"]:
            h.update(im.numpy().tobytes())
        h.update(json.dumps([batch["image_sizes"], batch["modalities"]]).encode())
        if b % 50 == 49:
            conc = max(conc, wprobe.footprint()[0] + (wprobe.current_sum() if args.workers else 0))
    res["iter_s"] = round(time.perf_counter() - t1, 3)  # includes worker shutdown
    res["iter_to_last_batch_s"] = round(last, 3)
    cur, peak = wprobe.footprint()
    res["main_footprint_end_mb"] = round(cur / 2**20, 1)
    res["main_lifetime_peak_mb"] = round(peak / 2**20, 1)
    res["max_concurrent_total_mb"] = round(max(conc, cur) / 2**20, 1)
    if args.workers:
        res.update(wprobe.summary(t_iter))
        res["main_peak_plus_worker_peaks_mb"] = round(res["main_lifetime_peak_mb"] + res["worker_peak_sum_mb"], 1)
    res["sha256"] = h.hexdigest()
    print(json.dumps(res))
    import shutil
    shutil.rmtree(os.environ["WPROBE_DIR"], ignore_errors=True)


if __name__ == "__main__":
    main()
