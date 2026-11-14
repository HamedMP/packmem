"""Per-process memory and startup probes for DataLoader workers on macOS.

macOS does not let a process read another process's lifetime-peak footprint reliably, so each
worker reports its own: worker_init() starts a thread that writes the worker's current and
lifetime-peak phys_footprint to $WPROBE_DIR/<pid>.json every 0.2 s. CollateProbe records when
the worker finished its first batch. Works with fork and spawn (everything here is importable).
"""
import ctypes, json, os, threading, time

_libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
_state = {}
_lock = threading.Lock()


def footprint(pid=None):
    """(current, lifetime peak) phys_footprint in bytes, from proc_pid_rusage(RUSAGE_INFO_V4)."""
    buf = (ctypes.c_uint64 * 64)()
    if _libc.proc_pid_rusage(pid or os.getpid(), 4, buf) != 0:
        return 0, 0
    return buf[2 + 7], buf[2 + 28]


def _write():
    d = os.environ["WPROBE_DIR"]
    with _lock:  # the reporting thread and CollateProbe both write
        cur, peak = footprint()
        _state.update(cur=cur, peak=peak, t=time.time())
        tmp = os.path.join(d, f".{os.getpid()}.tmp")
        with open(tmp, "w") as f:
            json.dump(_state, f)
        os.replace(tmp, os.path.join(d, f"{os.getpid()}.json"))


def worker_init(wid):
    import psutil
    cur, peak = footprint()  # the dataset has been unpickled by now
    _state.update(wid=wid, pid=os.getpid(), create=psutil.Process().create_time(), init=time.time(),
                  init_cur=cur, init_peak=peak, init_rss=psutil.Process().memory_info().rss)
    d = os.environ.get("WPROBE_DIAG")  # diagnostic runs only: footprint/vmmap of this worker right after unpickling
    if d:
        import subprocess
        for tool, cmd in (("footprint", ["footprint", "-p", str(os.getpid())]), ("vmmap", ["vmmap", "-summary", str(os.getpid())])):
            with open(os.path.join(d, f"init_w{wid}_{os.getpid()}.{tool}.txt"), "w") as f:
                subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)

    def loop():
        while True:
            _write()
            time.sleep(0.2)

    threading.Thread(target=loop, daemon=True).start()


class CollateProbe:
    def __init__(self, fn):
        self.fn = fn

    def __call__(self, batch):
        out = self.fn(batch)
        if "wid" in _state and "first_batch" not in _state:
            _state["first_batch"] = time.time()
            _write()
        return out


def read_workers():
    d = os.environ["WPROBE_DIR"]
    out = []
    for name in os.listdir(d):
        if name.endswith(".json"):
            try:
                with open(os.path.join(d, name)) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
    return sorted(out, key=lambda r: r.get("wid", -1))


def summary(t_iter_start):
    """Per-worker peak footprint (MB) and startup times relative to the parent's iter() call."""
    ws = read_workers()
    mb = lambda b: round(b / 2**20, 1)
    return {
        "worker_peak_mb": [mb(w["peak"]) for w in ws],
        "worker_peak_sum_mb": mb(sum(w["peak"] for w in ws)),
        "worker_last_mb": [mb(w["cur"]) for w in ws],
        "worker_init_mb": [mb(w["init_cur"]) for w in ws],
        "worker_init_peak_mb": [mb(w["init_peak"]) for w in ws],
        "worker_init_rss_mb": [mb(w["init_rss"]) for w in ws],
        "worker_start_to_first_batch_s": [round(w["first_batch"] - w["create"], 3) for w in ws if "first_batch" in w],
        "worker_iter_to_first_batch_s": [round(w["first_batch"] - t_iter_start, 3) for w in ws if "first_batch" in w],
        "worker_iter_to_init_s": [round(w["init"] - t_iter_start, 3) for w in ws],
        "worker_iter_to_create_s": [round(w["create"] - t_iter_start, 3) for w in ws],
    }


def current_sum():
    """Sum of the workers' current footprints (bytes), from their last report."""
    return sum(w["cur"] for w in read_workers())
