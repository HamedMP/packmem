"""Build qwen-vl-finetune's LazySupervisedDataset without a model and measure it.

v3 of harness/v2/bench_v2.py. Workload, sampling, batching and hashing are unchanged. Added:
- share info (.pkm path, size, mode) for a dataset whose table was share()d, in every mode
- loader: whether the .pkm still exists after the last batch; DIAG=1 runs `footprint` and
  `vmmap -summary` on the parent and each worker at the 50% batch (diagnostic runs only)
- hash mode: the loader's batches with num_workers=0 (same sampler, batch size and collator),
  to hash an arm that does not fit in memory with 4 spawn workers
- pickle mode: the table's own pickled size, read-only checks and file lifetime for a shared table
MB here is 1e6 bytes, as in v1.

usage: bench_v3.py TREE MODE DATASETS OUT_JSON
  TREE      checkout root containing qwen-vl-finetune/
  MODE      build | loader | verify | pickle | hash
  env       MP_CTX=fork|spawn (loader), N_SAMPLES (default 20000), DIAG=1 (loader)
  DATASETS  comma list for --dataset_use, e.g. llava665k or llava665k%50,llava150k
"""
import gc
import hashlib
import json
import os
import random
import stat
import subprocess
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


def share_info(t):
    sh = getattr(t, "_share", None)
    if sh is None:
        return {}
    st_ = os.stat(sh.path)
    return {"pkm_path": sh.path, "pkm_dir": os.path.dirname(sh.path), "pkm_bytes": st_.st_size,
            "pkm_size_field": sh.size, "pkm_mode": stat.filemode(st_.st_mode), "table_shared": t.shared}


def resident_fraction(path):
    """Share of the file's pages in the page cache, from mincore() on a fresh read-only mapping (faults nothing)."""
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    libc.mmap.restype = ctypes.c_void_p
    libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_longlong]
    fd = os.open(path, os.O_RDONLY)
    try:
        size = os.fstat(fd).st_size
        addr = libc.mmap(None, size, 1, 1, fd, 0)  # PROT_READ, MAP_SHARED
        pages = (size + 16383) // 16384
        vec = (ctypes.c_char * pages)()
        libc.mincore(ctypes.c_void_p(addr), ctypes.c_size_t(size), vec)
        libc.munmap(ctypes.c_void_p(addr), ctypes.c_size_t(size))
        return round(sum(1 for b in vec.raw if b & 1) / pages, 4)
    finally:
        os.close(fd)


def evict(path):
    """Replace the file with a byte-identical copy written and read through F_NOCACHE descriptors, so its pages are
    not in the page cache (no sudo purge). Same path, same mode, new inode."""
    import fcntl
    st_ = os.stat(path)
    tmp = path + ".cold"
    src = os.open(path, os.O_RDONLY)
    dst = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, st_.st_mode & 0o777)
    fcntl.fcntl(src, fcntl.F_NOCACHE, 1)
    fcntl.fcntl(dst, fcntl.F_NOCACHE, 1)
    while True:
        chunk = os.read(src, 1 << 24)
        if not chunk:
            break
        os.write(dst, chunk)
    os.fsync(dst)
    os.close(dst)
    os.close(src)
    os.replace(tmp, path)


def children_now():
    out = []
    for k in psutil.Process().children(recursive=True):
        try:
            out.append({"pid": k.pid, "ppid": k.ppid(), "cmd": " ".join(k.cmdline())[-90:],
                        "footprint_mb": round(footprint(k.pid) / 1e6), "rss_mb": round(k.memory_info().rss / 1e6)})
        except Exception:
            pass
    return out


def diag(tag, pids):
    d = out_path + ".diag"
    os.makedirs(d, exist_ok=True)
    for role, pid in pids:
        for tool, cmd in (("footprint", ["footprint", "-p", str(pid)]), ("vmmap", ["vmmap", "-summary", str(pid)])):
            with open(os.path.join(d, f"{tag}_{role}_{pid}.{tool}.txt"), "w") as f:
                subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)


def try_op(fn):
    try:
        fn()
        return "ok"
    except Exception as e:
        return f"{type(e).__name__}: {e}"


def main():
    res = {"tree": tree, "mode": mode, "datasets": datasets, "pid": os.getpid()}
    ds, res["build_s"] = build()
    res["n"] = len(ds)
    res["rss_after_build_mb"] = psutil.Process().memory_info().rss / 1e6
    res["footprint_after_build_mb"] = footprint(os.getpid()) / 1e6
    res.update(share_info(ds.list_data_dict))
    if hasattr(ds.list_data_dict, "nbytes"):
        res["table_nbytes"] = ds.list_data_dict.nbytes
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
        res["table_pickle_bytes"] = len(pickle.dumps(ds.list_data_dict))
        if hasattr(ds.list_data_dict, "nbytes"):
            res["table_nbytes_mb"] = ds.list_data_dict.nbytes / 1e6
        res["roundtrip_equal"] = len(back) == len(ds) and all(
            a == b for a, b in zip(back.list_data_dict, ds.list_data_dict))
        t = ds.list_data_dict
        if getattr(t, "_share", None) is not None:
            import packmem
            path = t._share.path
            b = back.list_data_dict
            row = b[0]
            res["attached_shared"] = b.shared
            res["attached_ops"] = {
                "setitem": try_op(lambda: b.__setitem__(0, row)),
                "append": try_op(lambda: b.append(row)),
                "set_column": try_op(lambda: b.set_column("data_path", "x")),
                "lazy_row_write": try_op(lambda: next(b.lazy()).__setitem__("data_path", "x")),
                "dict_row_write": try_op(lambda: b[0].__setitem__("data_path", "x")),  # a plain dict copy
                "share_again": try_op(lambda: b.share()),
            }
            res["parent_ops"] = {
                "setitem": try_op(lambda: t.__setitem__(0, row)),
                "lazy_row_write": try_op(lambda: next(t.lazy()).__setitem__("data_path", "x")),
            }
            c = b.copy()
            res["copy_ops"] = {"shared": c.shared, "append": try_op(lambda: c.append(row)), "len": len(c)}
            del c, b, back, row
            res["parent_row0_unchanged"] = t[0]["data_path"] == "/datasets/llava/images"
            t0 = time.perf_counter()
            t.unshare()
            res["unshare_s"] = time.perf_counter() - t0
            res["pkm_exists_after_unshare"] = os.path.exists(path)
            res["writable_after_unshare"] = try_op(lambda: t.set_column("probe", 1))
            t0 = time.perf_counter()
            t.share()
            res["share_s"] = time.perf_counter() - t0
            path2 = t._share.path
            blob2 = pickle.dumps(ds)
            del t
            ds = None
            gc.collect()
            res["pkm_exists_after_del_gc"] = os.path.exists(path2)
            res["loads_after_owner_gone"] = try_op(lambda: pickle.loads(blob2))
            res["stale_left_by_self"] = sorted(n for n in os.listdir(tempfile.gettempdir())
                                               if n.startswith(f"packmem-{os.getpid()}-"))
        json.dump(res, open(out_path, "w"), indent=1)
        return

    if mode == "hash":
        n_samples = int(os.environ.get("N_SAMPLES", "20000"))
        rng = random.Random(1)
        if n_samples >= len(ds):
            idx = list(range(len(ds)))
            rng.shuffle(idx)
        else:
            idx = [rng.randrange(len(ds)) for _ in range(n_samples)]
        collator = dp.DataCollatorForSupervisedDataset(tokenizer=StubTokenizer())
        dl = torch.utils.data.DataLoader(ds, batch_size=4, sampler=idx, num_workers=0, collate_fn=collator)
        t0 = time.perf_counter()
        for batch in dl:
            for k in ("input_ids", "labels", "position_ids"):
                h.update(batch[k].numpy().tobytes())
        res.update(hash_s=time.perf_counter() - t0, n_samples=len(idx), batches_sha256=h.hexdigest())
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
        if os.environ.get("DIAG") == "1":
            os.environ["WPROBE_DIAG"] = out_path + ".diag"  # workers save footprint/vmmap at worker_init
            os.makedirs(os.environ["WPROBE_DIAG"], exist_ok=True)
        if "pkm_path" in res:
            res["pkm_resident_after_build"] = resident_fraction(res["pkm_path"])
            if os.environ.get("PKM_COLD") == "1":
                t0 = time.perf_counter()
                evict(res["pkm_path"])
                res["evict_s"] = round(time.perf_counter() - t0, 2)
                res["pkm_mode_after_evict"] = stat.filemode(os.stat(res["pkm_path"]).st_mode)
            res["pkm_resident_before_iter"] = resident_fraction(res["pkm_path"])
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
                if b == int(n_batches * 0.5):
                    res["children_at_50pct"] = children_now()
                if os.environ.get("DIAG") == "1" and b == int(n_batches * 0.5):
                    others = [(f"c{c['pid']}", c["pid"]) for c in res["children_at_50pct"] if c["pid"] not in pids]
                    diag("p50", [("parent", os.getpid())] + [(f"w{k}", p) for k, p in enumerate(pids)] + others)
            if b == int(n_batches * 0.9):
                pids = [w.pid for w in it._workers]
                res["worker_footprint_mb"] = [footprint(p) / 1e6 for p in pids]
                res["worker_rss_mb"] = [psutil.Process(p).memory_info().rss / 1e6 for p in pids]
                res["main_footprint_at_90pct_mb"] = footprint(os.getpid()) / 1e6
                res["main_rss_at_90pct_mb"] = psutil.Process().memory_info().rss / 1e6
                res["total_footprint_mb"] = res["main_footprint_at_90pct_mb"] + sum(res["worker_footprint_mb"])
        res["loader_s"] = time.perf_counter() - t0  # includes worker shutdown
        res["iter_to_last_batch_s"] = last
        if "pkm_path" in res:
            res["pkm_exists_after_epoch"] = os.path.exists(res["pkm_path"])
            res["pkm_resident_after_epoch"] = resident_fraction(res["pkm_path"])
        res.update(wprobe.summary(t_iter))
        res["main_lifetime_peak_mib"] = wprobe.footprint()[1] / 2**20
        res["max_concurrent_total_mib"] = conc / 2**20
        res["main_peak_plus_worker_peaks_mib"] = res["main_lifetime_peak_mib"] + res["worker_peak_sum_mb"]  # wprobe reports MiB
    res["n_samples"] = len(idx)
    res["batches_sha256"] = h.hexdigest()
    json.dump(res, open(out_path, "w"), indent=1)


if __name__ == "__main__":
    main()
