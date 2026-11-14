"""bench_dl2.py ARM START [CACHE_DIR]: bench_dl.py plus per-mapping splits of the .pkm / .arrow files, Pss_Shmem,
the shared file itself, and the pickled size for every forkserver arm and every v2 arm."""
import hashlib
import json
import os
import random
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import dlcommon  # noqa: E402

perf = C.perf


class Sampler(threading.Thread):
    def __init__(self, interval=0.5):
        super().__init__(daemon=True)
        import psutil

        self.me = psutil.Process()
        self.interval = interval
        self.stop = threading.Event()
        self.peak_pss_sum = self.peak_uss_sum = 0
        self.peak_pss_workers = self.peak_uss_workers = 0
        self.per = {}
        self.samples = 0
        self.max_workers_seen = 0
        self.tmpfs_bytes = 0

    def role(self, p):
        if p.pid == self.me.pid:
            return "parent"
        try:
            cmd = " ".join(p.cmdline())
            if p.ppid() == self.me.pid and ("forkserver" in cmd or "resource_tracker" in cmd):
                return "aux"
        except Exception:
            return None
        return "worker"

    def sample(self):
        procs = [self.me] + self.me.children(recursive=True)
        pss = uss = wpss = wuss = anon = 0
        pkm_pss = shmem = 0
        nworkers = 0
        for p in procs:
            role = self.role(p)
            if role is None:
                continue
            try:
                r = C.rollup(p.pid)
            except Exception:
                continue
            pss += r["Pss"]
            uss += r["USS"]
            anon += r["Pss_Anon"]
            if role == "worker":
                wpss += r["Pss"]
                wuss += r["USS"]
                nworkers += 1
            e = self.per.setdefault(p.pid, {"role": role})
            for k in ("USS", "Pss", "Rss", "Private_Dirty", "Private_Clean", "Pss_Anon", "Pss_File"):
                e["peak_" + k] = max(e.get("peak_" + k, 0), r[k])
            try:
                a = C.arrow_maps(p.pid)
                e["peak_arrow_rss"] = max(e.get("peak_arrow_rss", 0), a["Rss"])
                e["peak_arrow_private"] = max(e.get("peak_arrow_private", 0), a["Private"])
            except Exception:
                pass
            for suffix, tag in ((".pkm", "pkm"), (".arrow", "arrowmap")):
                try:
                    m = C.file_maps(p.pid, suffix)
                except Exception:
                    continue
                if m["paths"]:
                    e[tag + "_paths"] = m["paths"]
                for k in C.MAP_KEYS:
                    e[f"peak_{tag}_{k}"] = max(e.get(f"peak_{tag}_{k}", 0), m[k])
                if tag == "pkm":
                    pkm_pss += m["Pss"]
            shmem += r["Pss_Shmem"]
        self.peak_anon_sum = max(getattr(self, "peak_anon_sum", 0), anon)
        self.peak_shmem_sum = max(getattr(self, "peak_shmem_sum", 0), shmem)
        # a tmpfs file is RAM whether or not anyone maps it: count the whole file once instead of its mapped share
        tot = pss - pkm_pss + self.tmpfs_bytes if self.tmpfs_bytes else pss
        self.peak_total_incl_tmpfs = max(getattr(self, "peak_total_incl_tmpfs", 0), tot)
        self.peak_pss_sum = max(self.peak_pss_sum, pss)
        self.peak_uss_sum = max(self.peak_uss_sum, uss)
        self.peak_pss_workers = max(self.peak_pss_workers, wpss)
        self.peak_uss_workers = max(self.peak_uss_workers, wuss)
        self.max_workers_seen = max(self.max_workers_seen, nworkers)
        self.samples += 1

    def run(self):
        while not self.stop.is_set():
            self.sample()
            self.stop.wait(self.interval)


def main():
    arm, start = sys.argv[1], sys.argv[2]
    cache = sys.argv[3] if len(sys.argv) > 3 else None
    import torch
    from torch.utils.data import DataLoader

    out = {"arm": arm, "start": start, "torch": torch.__version__}
    x, t_load, t_norm = C.load(arm, cache)
    out["load_s"], out["norm_s"] = t_load, t_norm
    ds = dlcommon.Holder(x)
    n = len(ds)
    idx = random.Random(0).sample(range(n), 20_000)
    out["extra"] = dict(C.EXTRA)
    if start == "forkserver" or arm.startswith("V2"):
        from multiprocessing.reduction import ForkingPickler

        t0 = perf()
        out["pickled_dataset_bytes"] = len(ForkingPickler.dumps(ds))
        out["pickle_s"] = perf() - t0
    import gc

    gc.collect()
    out["parent_after_load"] = C.rollup()
    s = Sampler()
    f = C.EXTRA.get("file")
    if f and f["fs"] == "tmpfs":
        s.tmpfs_bytes = f["size"]
    s.sample()
    out["baseline_pss_sum"] = s.peak_pss_sum
    s.start()
    dl = DataLoader(ds, batch_size=8, num_workers=4, sampler=idx, collate_fn=C.collate,
                    multiprocessing_context=start, persistent_workers=True)
    h = hashlib.sha256()
    t0 = perf()
    it = iter(dl)
    first = next(it)
    out["first_batch_s"] = perf() - t0
    s.sample()
    for hh in first:
        h.update(hh.encode())
    nb = 1
    for b in it:
        for hh in b:
            h.update(hh.encode())
        nb += 1
    out["epoch_s"] = perf() - t0
    s.sample()  # persistent workers are still alive here, holding whatever the epoch made them touch
    out["end_of_epoch"] = {str(p.pid): C.rollup(p.pid) for p in s.me.children(recursive=True)}
    out["end_of_epoch_pkm"] = {str(p.pid): C.file_maps(p.pid, ".pkm") for p in s.me.children(recursive=True)}
    out["end_of_epoch_arrow"] = {str(p.pid): C.file_maps(p.pid, ".arrow") for p in s.me.children(recursive=True)}
    del it, dl
    time.sleep(0.6)
    s.stop.set()
    s.join()
    out["batches"] = nb
    out["batch_digest"] = h.hexdigest()
    out["peak_pss_sum"] = s.peak_pss_sum
    out["peak_uss_sum"] = s.peak_uss_sum
    out["peak_pss_anon_sum"] = s.peak_anon_sum
    out["peak_pss_shmem_sum"] = s.peak_shmem_sum
    out["peak_total_incl_tmpfs"] = s.peak_total_incl_tmpfs
    if f:
        out["file_exists_at_end"] = os.path.exists(f["path"])
    out["peak_pss_workers"] = s.peak_pss_workers
    out["peak_uss_workers"] = s.peak_uss_workers
    out["max_workers_seen"] = s.max_workers_seen
    out["samples"] = s.samples
    out["per_process"] = s.per
    print(json.dumps(out))


if __name__ == "__main__":
    main()
