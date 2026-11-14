"""Linux memory figures, the stand-ins for macOS phys_footprint / malloc_zone_statistics / vmmap used elsewhere.

smaps(pid): /proc/<pid>/smaps_rollup in MB (1e6): Rss, Pss, Pss_Anon, Pss_File, Private_Dirty, Private_Clean, USS.
hwm(pid): VmHWM (peak RSS) in MB. maxrss(): ru_maxrss of this process in MB.
mallinfo(): glibc mallinfo2() in MB: in_use = uordblks + hblkhd, free_in_arenas = fordblks (freed, still held).
snap(): smaps + VmHWM + mallinfo of this process, after gc.collect().
reuse(): with REUSE_MB=N, allocate about N MiB in 2-32 MiB bytearrays and report the USS growth (as memprobe.reuse).
"""
import ctypes, gc, os, resource

FIELDS = ("Rss", "Pss", "Pss_Anon", "Pss_File", "Pss_Shmem", "Shared_Clean", "Shared_Dirty", "Private_Clean", "Private_Dirty", "Swap")


def smaps(pid=None):
    out = {}
    with open(f"/proc/{pid or 'self'}/smaps_rollup") as f:
        for line in f:
            k, _, rest = line.partition(":")
            if k in FIELDS:
                out[k] = round(int(rest.split()[0]) * 1024 / 1e6, 1)
    out["USS"] = round(out.get("Private_Clean", 0) + out.get("Private_Dirty", 0), 1)
    return out


def hwm(pid=None):
    with open(f"/proc/{pid or 'self'}/status") as f:
        for line in f:
            if line.startswith("VmHWM:"):
                return round(int(line.split()[1]) * 1024 / 1e6, 1)
    return None


def maxrss():
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024 / 1e6, 1)


class _MI2(ctypes.Structure):
    _fields_ = [(n, ctypes.c_size_t) for n in ("arena", "ordblks", "smblks", "hblks", "hblkhd", "usmblks",
                                                "fsmblks", "uordblks", "fordblks", "keepcost")]


def mallinfo():
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.mallinfo2.restype = _MI2
        m = libc.mallinfo2()
    except Exception as e:
        return {"error": str(e)}
    return {"in_use_mb": round((m.uordblks + m.hblkhd) / 1e6, 1), "mmapped_mb": round(m.hblkhd / 1e6, 1),
            "arena_mb": round(m.arena / 1e6, 1), "free_in_arenas_mb": round(m.fordblks / 1e6, 1)}


def snap():
    gc.collect()
    return {"smaps": smaps(), "VmHWM_mb": hwm(), "ru_maxrss_mb": maxrss(), "malloc": mallinfo()}


def reuse():
    n = int(os.environ.get("REUSE_MB", "0"))
    if not n:
        return None
    before = snap()
    sizes, blocks, total = (2, 4, 8, 16, 32), [], 0
    while total < n:
        mib = sizes[len(blocks) % len(sizes)]
        blocks.append(bytearray(mib * 2**20))
        total += mib
    after = snap()
    del blocks
    freed = snap()
    alloc = total * 2**20 / 1e6
    grew = after["smaps"]["USS"] - before["smaps"]["USS"]
    return {"alloc_mb": round(alloc, 1), "uss_growth_mb": round(grew, 1), "reused_mb": round(alloc - grew, 1),
            "before": before, "after_alloc": after, "after_free": freed}


class Sampler:
    """Pss_Anon of this process every `period` seconds on a background thread: [(seconds since start, MB), ...]."""

    def __init__(self, period=0.2):
        import threading, time
        self._time, self._stop, self.series = time, threading.Event(), []
        self._t0 = time.perf_counter()
        self._th = threading.Thread(target=self._run, args=(period,), daemon=True)
        self._th.start()

    def _run(self, period):
        while not self._stop.is_set():
            try:
                self.series.append((round(self._time.perf_counter() - self._t0, 2), smaps()["Pss_Anon"]))
            except OSError:
                pass
            self._stop.wait(period)

    def stop(self):
        self._stop.set()
        self._th.join()
        return {"samples": self.series, "max_pss_anon_mb": max((v for _, v in self.series), default=None)}


def release_and_settle(table, settle=5.0):
    """Call the table's release_freed_memory() where the build has it, wait `settle` s, and snapshot again."""
    import time
    fn = None
    for owner in (table, getattr(table, "_t", None)):
        if owner is not None and hasattr(owner, "release_freed_memory"):
            fn = owner.release_freed_memory
            break
    if fn is None:
        try:
            from packmem._packmem import _Table
            if hasattr(_Table, "release_freed_memory"):
                fn = lambda: _Table.release_freed_memory()  # noqa: E731
        except Exception:
            pass
    out = {"release_freed_memory": "missing" if fn is None else "called"}
    if fn is not None:
        try:
            out["returned"] = repr(fn())
        except Exception as e:
            out["release_freed_memory"] = f"{type(e).__name__}: {e}"
    time.sleep(settle)
    out["after_settle"] = snap()
    return out
