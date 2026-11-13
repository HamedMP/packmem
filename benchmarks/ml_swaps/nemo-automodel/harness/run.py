"""Build NeMo Automodel's meta VLM dataset (make_meta_dataset) from one repository
checkout and measure or fingerprint it. Prints one JSON line (and appends it to --out).

modes
  dump    every example's sha256(repr), .stats, sampler outputs and collate outputs
          for a fixed index set (DistributedSampler rank 0 order), plus a check of
          whether the stored records were mutated by PreTokenizedDatasetWrapper.
  build   only make_meta_dataset: time, RSS and footprint.
  pickle  make_meta_dataset, then pickle.dumps/loads of the dataset (size, time).
  loader  the recipe path: VlmDataloaderConfig(MetaDatasetConfig, pretokenization)
          .build(dp_rank=0, dp_world_size=8, batch_size=8) with --workers under
          --start-method; reads --batches batches; per-worker peak footprint,
          startup time (iter() to first batch) and a hash of every batch.

Images are not on this machine: PIL.Image.open and transformers' load_image return
a small generated image derived from the path, identically in both arms and in workers.
"""
import argparse
import ctypes
import hashlib
import json
import os
import pickle
import resource
import sys
import threading
import time
import zlib

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--meta", required=True)
ap.add_argument("--mode", choices=["dump", "build", "pickle", "loader"], required=True)
ap.add_argument("--processor", default=None)
ap.add_argument("--shard", action="store_true", help="shard_data=True, rank 0 of --world-size")
ap.add_argument("--world-size", type=int, default=8)
ap.add_argument("--workers", type=int, default=4)
ap.add_argument("--start-method", default="spawn", choices=["spawn", "fork", "forkserver"])
ap.add_argument("--batches", type=int, default=32)
ap.add_argument("--batch-size", type=int, default=8)
ap.add_argument("--pipeline", default="default", choices=["default", "pretokenize"],
                help="loader: default = processor collate on raw examples (picklable for spawn); "
                "pretokenize = PreTokenizedDatasetWrapper + robust collate (fork only upstream)")
ap.add_argument("--fake-image", default="small", choices=["small", "coco"],
                help="small: 56-140 px; coco: 640x480, about the size of a decoded COCO image")
ap.add_argument("--digests", default=None, help="dump: write per-example digests here")
ap.add_argument("--out", default=None)
ap.add_argument("--tag", default="")
args, _ = ap.parse_known_args()

sys.path.insert(0, os.path.abspath(args.repo))

import PIL.Image  # noqa: E402
import transformers.image_utils as _tiu  # noqa: E402

_real_new = PIL.Image.new


def fake_image(path):
    h = zlib.crc32(str(path).encode())
    if args.fake_image == "coco":
        w, hh = (640, 480) if h % 2 else (480, 640)
    else:
        w, hh = 28 * (2 + h % 4), 28 * (2 + (h >> 4) % 4)
    return _real_new("RGB", (w, hh), (h & 255, (h >> 8) & 255, (h >> 16) & 255))


PIL.Image.open = lambda fp, *a, **k: fake_image(fp)
_real_load_image = _tiu.load_image
_tiu.load_image = lambda image, timeout=None: fake_image(image) if isinstance(image, str) else _real_load_image(image, timeout)
_real_as_tensor = _tiu.load_image_as_tensor


def _fake_as_tensor(image, timeout=None):
    return _real_as_tensor(fake_image(image) if isinstance(image, str) else image, timeout)


_tiu.load_image_as_tensor = _fake_as_tensor
import transformers.image_processing_backends as _tipb  # noqa: E402

_tipb.load_image_as_tensor = _fake_as_tensor

_libc = ctypes.CDLL(None)


def footprint():
    """(current, lifetime peak) bytes. macOS: phys_footprint via proc_pid_rusage (includes
    compressed pages). Linux: VmRSS / VmHWM."""
    if sys.platform == "darwin":
        buf = (ctypes.c_uint64 * 64)()
        if _libc.proc_pid_rusage(os.getpid(), 4, buf) != 0:
            return 0, 0
        return int(buf[2 + 7]), int(buf[2 + 28])
    cur = peak = 0
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                cur = int(line.split()[1]) * 1024
            elif line.startswith("VmHWM:"):
                peak = int(line.split()[1]) * 1024
    return cur, peak


def maxrss():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r if sys.platform == "darwin" else r * 1024


def worker_init(worker_id):
    """Each worker records its own peak footprint (macOS denies reading other processes)."""
    import torch.utils.data as tud

    memdir = os.environ["PM_MEMDIR"]
    t_ready = time.time()
    info = tud.get_worker_info()
    inner = getattr(info.dataset, "dataset", info.dataset)
    meta = {
        "dataset_type": type(info.dataset).__name__,
        "inner_type": type(inner).__name__,
        "inner_stats": getattr(inner, "stats", None),
        "ready_unix": t_ready,
    }
    with open(os.path.join(memdir, f"{os.getpid()}.meta"), "w") as f:
        json.dump(meta, f)

    def loop():
        path = os.path.join(memdir, str(os.getpid()))
        while True:
            with open(path + ".tmp", "w") as f:
                f.write(str(footprint()[1]))
            os.replace(path + ".tmp", path)
            time.sleep(0.1)

    threading.Thread(target=loop, daemon=True).start()


def tensor_digest(obj, h):
    import torch

    if isinstance(obj, torch.Tensor):
        t = obj.detach().contiguous().cpu()
        h.update(f"T{tuple(t.shape)}{t.dtype}".encode())
        h.update(t.view(torch.uint8).numpy().tobytes() if t.numel() else b"")
    elif isinstance(obj, dict):
        for k in sorted(obj):
            h.update(f"K{k}".encode())
            tensor_digest(obj[k], h)
    elif isinstance(obj, (list, tuple)):
        h.update(f"L{len(obj)}".encode())
        for v in obj:
            tensor_digest(v, h)
    else:
        h.update(repr(obj).encode())


def mb(x):
    return round(x / 2**20, 1)


def emit(res):
    res.update(
        tag=args.tag,
        mode=args.mode,
        repo=os.path.basename(os.path.abspath(args.repo)),
        shard=args.shard,
        loadavg=list(os.getloadavg()),
        main_maxrss_mb=mb(maxrss()),
        main_peak_footprint_mb=mb(footprint()[1]),
    )
    line = json.dumps(res)
    print(line)
    if args.out:
        with open(args.out, "a") as f:
            f.write(line + "\n")


def build_dataset():
    from nemo_automodel.components.datasets.vlm.datasets import make_meta_dataset

    t0 = time.perf_counter()
    if args.shard:
        ds = make_meta_dataset(args.meta, shard_data=True, rank=0, world_size=args.world_size)
    else:
        ds = make_meta_dataset(args.meta)
    return ds, time.perf_counter() - t0


def main_dump():
    import torch
    from torch.utils.data.distributed import DistributedSampler
    from transformers import AutoProcessor

    from nemo_automodel.components.datasets.vlm.collate_fns import pad_collate_fn, qwen2_5_collate_fn
    from nemo_automodel.components.datasets.vlm.datasets import PreTokenizedDatasetWrapper
    from nemo_automodel.components.datasets.vlm.samplers import LengthGroupedSampler

    ds, t_build = build_dataset()
    res = {"n": len(ds), "type": type(ds).__name__, "stats": getattr(ds, "stats", None), "build_s": round(t_build, 2)}

    whole = hashlib.sha256()
    digests = []
    for ex in ds:
        d = hashlib.sha256(repr(ex).encode()).hexdigest()[:16]
        digests.append(d)
        whole.update(d.encode())
    res["examples_sha"] = whole.hexdigest()
    res["indexed_equals_iterated"] = all(
        hashlib.sha256(repr(ds[i]).encode()).hexdigest()[:16] == digests[i] for i in range(0, len(ds), 97)
    )
    if args.digests:
        with open(args.digests, "w") as f:
            f.write("\n".join(digests) + "\n")

    samp = hashlib.sha256()
    for rank in range(8):
        s = DistributedSampler(ds, num_replicas=8, rank=rank, shuffle=True, seed=42)
        s.set_epoch(1)
        samp.update(repr(list(s)).encode())
    res["distributed_sampler_sha"] = samp.hexdigest()

    proc = AutoProcessor.from_pretrained(args.processor)
    lgs = LengthGroupedSampler(ds, seed=42, processor=proc)
    res["vlm_length_grouped_sampler_sha"] = hashlib.sha256(
        repr((lgs.sorted_indices, lgs.text_lengths, lgs.media_lengths, list(lgs))).encode()
    ).hexdigest()

    order = list(DistributedSampler(ds, num_replicas=8, rank=0, shuffle=True, seed=42))
    index_set = order[: args.batches * args.batch_size]
    res["index_set_sha"] = hashlib.sha256(repr(index_set).encode()).hexdigest()[:16]
    batches = [index_set[i : i + args.batch_size] for i in range(0, len(index_set), args.batch_size)]

    h = hashlib.sha256()
    for b in batches:
        tensor_digest(qwen2_5_collate_fn([ds[i] for i in b], proc), h)
    res["qwen2_5_collate_sha"] = h.hexdigest()

    wrapper = PreTokenizedDatasetWrapper(ds, proc)
    h = hashlib.sha256()
    for b in batches:
        tensor_digest(pad_collate_fn([wrapper[i] for i in b], proc), h)
    res["pretokenized_pad_collate_sha"] = h.hexdigest()

    def holds_pil(ex):
        return any(
            isinstance(item, dict) and isinstance(item.get("image"), PIL.Image.Image)
            for msg in ex["conversation"]
            for item in (msg["content"] if isinstance(msg["content"], list) else [])
        )

    res["records_mutated_to_hold_pil_after_pretokenize"] = sum(holds_pil(ds[i]) for i in set(index_set))
    res["records_with_image_in_index_set"] = sum(
        any(
            isinstance(it, dict) and it.get("type") == "image"
            for m in ds[i]["conversation"]
            for it in (m["content"] if isinstance(m["content"], list) else [])
        )
        for i in set(index_set)
    )
    h = hashlib.sha256()
    for b in batches:
        tensor_digest(pad_collate_fn([wrapper[i] for i in b], proc), h)
    res["pretokenized_pad_collate_second_pass_sha"] = h.hexdigest()
    emit(res)


def main_build():
    ds, t_build = build_dataset()
    cur, _ = footprint()
    emit({"n": len(ds), "type": type(ds).__name__, "build_s": round(t_build, 2), "footprint_after_build_mb": mb(cur)})


def main_pickle():
    ds, t_build = build_dataset()
    cur, _ = footprint()
    t0 = time.perf_counter()
    blob = pickle.dumps(ds, protocol=pickle.HIGHEST_PROTOCOL)
    t_dump = time.perf_counter() - t0
    t0 = time.perf_counter()
    back = pickle.loads(blob)
    t_load = time.perf_counter() - t0
    emit(
        {
            "n": len(ds),
            "build_s": round(t_build, 2),
            "footprint_after_build_mb": mb(cur),
            "pickle_mb": mb(len(blob)),
            "pickle_dumps_s": round(t_dump, 2),
            "pickle_loads_s": round(t_load, 2),
            "roundtrip_type": type(back).__name__,
            "roundtrip_stats_kept": getattr(back, "stats", None) == getattr(ds, "stats", None),
            "roundtrip_len_ok": len(back) == len(ds),
        }
    )


def main_loader():
    import tempfile

    import torch.multiprocessing as mp
    from transformers import AutoProcessor

    from nemo_automodel.components.datasets.vlm.datasets import MetaDatasetConfig, PreTokenizedDatasetWrapperConfig
    from nemo_automodel.components.datasets.vlm.loader import VlmDataloaderConfig, VlmProcessorConfig

    mp.set_start_method(args.start_method, force=True)
    memdir = tempfile.mkdtemp(prefix="pm-wmem-")
    os.environ["PM_MEMDIR"] = memdir
    timing = {}

    class TimedMeta(MetaDatasetConfig):
        def build(self, *, rank=None, world_size=None):
            t0 = time.perf_counter()
            out = super().build(rank=rank, world_size=world_size)
            timing["build_s"] = time.perf_counter() - t0
            timing["footprint_after_build"] = footprint()[0]
            return out

    cfg = VlmDataloaderConfig(
        dataset_config=TimedMeta(path_or_dataset=args.meta, shard_data=args.shard),
        processor_config=VlmProcessorConfig(factory=AutoProcessor.from_pretrained, kwargs={"pretrained_model_name_or_path": args.processor}),
        pretokenization=PreTokenizedDatasetWrapperConfig() if args.pipeline == "pretokenize" else None,
        num_workers=args.workers,
    )
    t0 = time.perf_counter()
    built = cfg.build(pretrained_model_name_or_path=args.processor, dp_rank=0, dp_world_size=args.world_size, batch_size=args.batch_size)
    t_cfg = time.perf_counter() - t0
    dl = built.dataloader
    dl.worker_init_fn = worker_init

    h = hashlib.sha256()
    t_iter = time.perf_counter()
    t_iter_unix = time.time()
    it = iter(dl)
    first = next(it)
    t_first = time.perf_counter() - t_iter
    tensor_digest(first, h)
    n = 1
    for batch in it:
        tensor_digest(batch, h)
        n += 1
        if n >= args.batches:
            break
    t_all = time.perf_counter() - t_iter
    time.sleep(0.3)
    peaks, metas = [], []
    for name in sorted(os.listdir(memdir)):
        p = os.path.join(memdir, name)
        if name.endswith(".meta"):
            with open(p) as f:
                metas.append(json.load(f))
        elif not name.endswith(".tmp"):
            with open(p) as f:
                peaks.append(int(f.read() or 0))
    del it
    emit(
        {
            "start_method": args.start_method,
            "pipeline": args.pipeline,
            "fake_image": args.fake_image,
            "workers": args.workers,
            "n_dataset": len(dl.dataset),
            "batches": n,
            "build_s": round(timing["build_s"], 2),
            "dataloader_config_build_s": round(t_cfg, 2),
            "footprint_after_build_mb": mb(timing["footprint_after_build"]),
            "startup_to_first_batch_s": round(t_first, 2),
            "worker_ready_after_iter_s": sorted(round(m["ready_unix"] - t_iter_unix, 2) for m in metas),
            "iterate_s": round(t_all, 2),
            "worker_peak_footprint_mb": sorted(mb(p) for p in peaks),
            "worker_peak_footprint_sum_mb": mb(sum(peaks)),
            "worker_view": metas[0] if metas else None,
            "batches_sha": h.hexdigest(),
        }
    )


if __name__ == "__main__":
    {"dump": main_dump, "build": main_build, "pickle": main_pickle, "loader": main_loader}[args.mode]()
