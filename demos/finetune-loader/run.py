"""Run one variant of the loader and record its memory.

    python run.py --mode packmem                 # list | hf | packmem | packmem-open
    python run.py --mode list --start fork --workers 4 --samples 20000

Builds the dataset in the parent, then iterates a DataLoader over seeded random indices. A thread in the parent
samples the parent and every worker every 0.25 s: resident memory (RSS), unique memory (USS, Linux only), and the figure the
operating system charges the process for. On macOS that is phys_footprint, which leaves out clean pages of a
memory-mapped file: the page cache holds those once for every process that maps the file. On Linux it is PSS, which
splits shared pages, mapped files included, between the processes that map them. Prints one JSON result, also
written to results/ unless --no-save.
"""
import argparse
import ctypes
import gc
import hashlib
import json
import os
import platform
import random
import sys
import threading
import time

import psutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dataset import MODES, ConversationDataset, collate, load_annotations  # noqa: E402

REPO, FILE = "liuhaotian/LLaVA-Instruct-150K", "llava_instruct_150k.json"
MB = 1e6

if sys.platform == "darwin":
    _libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")

    def charged(pid):
        """phys_footprint, from proc_pid_rusage(RUSAGE_INFO_V4): what Activity Monitor calls Memory."""
        buf = (ctypes.c_uint64 * 64)()
        return buf[2 + 7] if _libc.proc_pid_rusage(pid, 4, buf) == 0 else 0

    CHARGED = "footprint"
else:

    def charged(pid):
        """Proportional set size: shared pages split between the processes that map them."""
        with open(f"/proc/{pid}/smaps_rollup") as f:
            for line in f:
                if line.startswith("Pss:"):
                    return int(line.split()[1]) * 1024
        return 0

    CHARGED = "pss"


def memory(p):
    out = {"rss": p.memory_info().rss, CHARGED: charged(p.pid)}
    if sys.platform != "darwin":  # macOS reads another process's USS only with elevated privileges
        out["uss"] = p.memory_full_info().uss
    return out


class Sampler(threading.Thread):
    """Peaks per process, and peaks of the sums over the parent and its DataLoader workers."""

    def __init__(self, interval=0.25):
        super().__init__(daemon=True)
        self.me = psutil.Process()
        self.interval = interval
        self.done = threading.Event()
        self.per = {}
        self.peak_sum = {}
        self.workers_seen = 0

    def role(self, p):
        if p.pid == self.me.pid:
            return "parent"
        try:
            cmd = " ".join(p.cmdline())
        except psutil.Error:
            return None
        return "helper" if ("resource_tracker" in cmd or "forkserver" in cmd) else "worker"

    def sample(self):
        sums, workers = {}, 0
        for p in [self.me, *self.me.children(recursive=True)]:
            role = self.role(p)
            if role is None:
                continue
            try:
                m = memory(p)
            except psutil.Error:
                continue
            e = self.per.setdefault(p.pid, {"role": role})
            for k, v in m.items():
                e["peak_" + k] = max(e.get("peak_" + k, 0), v)
            if role != "helper":
                workers += role == "worker"
                for k, v in m.items():
                    sums[k] = sums.get(k, 0) + v
        for k, v in sums.items():
            self.peak_sum[k] = max(self.peak_sum.get(k, 0), v)
        self.workers_seen = max(self.workers_seen, workers)

    def run(self):
        while not self.done.is_set():
            self.sample()
            self.done.wait(self.interval)


def data_file(path):
    if path:
        return path
    from huggingface_hub import hf_hub_download

    return hf_hub_download(REPO, FILE, repo_type="dataset")


def versions():
    out = {"python": platform.python_version()}
    for name in ("torch", "packmem", "datasets"):
        try:
            out[name] = __import__(name).__version__
        except Exception:
            pass
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=MODES, required=True)
    ap.add_argument("--file", help=f"a JSON array of LLaVA-style records (default: {FILE} from {REPO})")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--start", choices=("spawn", "fork", "forkserver"), default="spawn")
    ap.add_argument("--samples", type=int, default=20_000)
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--cache-dir", default=os.path.join(HERE, ".cache"))
    ap.add_argument("--prepare", action="store_true", help="only build the mode's cache (Arrow, .pkm) and exit")
    ap.add_argument("--no-save", action="store_true")
    a = ap.parse_args()

    from torch.utils.data import DataLoader

    os.makedirs(a.cache_dir, exist_ok=True)
    path = data_file(a.file)
    res = {
        "mode": a.mode, "start": a.start, "workers": a.workers, "samples": a.samples, "batch_size": a.batch_size,
        "file": os.path.basename(path), "file_bytes": os.path.getsize(path), "versions": versions(),
        "machine": {"platform": sys.platform, "machine": platform.machine(), "cpus": os.cpu_count(),
                    "memory_gb": round(psutil.virtual_memory().total / 2**30)},
        "loadavg_at_start": os.getloadavg()[0], "charged_metric": CHARGED,
    }
    t0 = time.perf_counter()
    rows = load_annotations(path, a.mode, a.cache_dir)
    res["build_s"] = time.perf_counter() - t0
    res["records"] = len(rows)
    if a.prepare:
        print(json.dumps({k: res[k] for k in ("mode", "build_s", "records", "versions")}))
        return
    gc.collect()
    res["parent_after_build"] = memory(psutil.Process())

    ds = ConversationDataset(rows)
    idx = random.Random(0).sample(range(len(ds)), min(a.samples, len(ds)))
    s = Sampler()
    s.sample()
    s.start()
    dl = DataLoader(ds, batch_size=a.batch_size, num_workers=a.workers, sampler=idx, collate_fn=collate,
                    multiprocessing_context=a.start if a.workers else None)
    h = hashlib.sha256()
    t0 = time.perf_counter()
    batches = 0
    for ids, lengths in dl:
        if batches == 0:
            res["first_batch_s"] = time.perf_counter() - t0
            s.sample()
        h.update(json.dumps([ids, lengths]).encode())
        batches += 1
    res["total_s"] = time.perf_counter() - t0
    s.sample()
    del dl
    time.sleep(0.5)
    s.done.set()
    s.join()
    res.update(batches=batches, batch_digest=h.hexdigest(), workers_seen=s.workers_seen,
               peak_sum={k: v / MB for k, v in s.peak_sum.items()},
               per_process=[{"role": e["role"], **{k: v / MB for k, v in e.items() if k != "role"}} for e in s.per.values()])
    res["parent_after_build"] = {k: v / MB for k, v in res["parent_after_build"].items()}
    out = json.dumps(res)
    print(out)
    if not a.no_save:
        d = os.path.join(HERE, "results")
        os.makedirs(d, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        pm = res["versions"].get("packmem", "none")
        with open(os.path.join(d, f"{a.mode}_{a.start}_{pm}_{stamp}_{os.getpid()}.json"), "w") as f:
            f.write(out + "\n")


if __name__ == "__main__":
    main()
