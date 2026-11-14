"""Memory snapshot and reuse probe for macOS, shared by mixcheck.py and llava-next/harness/v3/vmcheck.py.

snap(): phys_footprint (current, lifetime peak) and malloc_zone_statistics(NULL) in-use / allocated, MB = 1e6.
tools(prefix): saves `footprint -p` and `vmmap -summary` of this process to PREFIX.{footprint,vmmap}.txt.
reuse(prefix): with REUSE_MB=N, allocates about N MiB in 2/4/8/16/32 MiB bytearrays (zero-filled, so every page is
written), and reports how much the footprint grew. Growth below the amount allocated means malloc reused memory that was
freed but still resident (MALLOC_LARGE (empty)) instead of mapping new pages.
"""
import ctypes, gc, os, subprocess

_libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")


class _MStats(ctypes.Structure):
    _fields_ = [("blocks_in_use", ctypes.c_uint), ("size_in_use", ctypes.c_size_t),
                ("max_size_in_use", ctypes.c_size_t), ("size_allocated", ctypes.c_size_t)]


def snap():
    gc.collect()
    buf = (ctypes.c_uint64 * 64)()
    _libc.proc_pid_rusage(os.getpid(), 4, buf)
    st = _MStats()
    _libc.malloc_zone_statistics(None, ctypes.byref(st))
    return {"footprint_mb": round(buf[2 + 7] / 1e6, 1), "peak_mb": round(buf[2 + 28] / 1e6, 1),
            "malloc_in_use_mb": round(st.size_in_use / 1e6, 1), "malloc_allocated_mb": round(st.size_allocated / 1e6, 1)}


def tools(prefix):
    for tool, cmd in (("footprint", ["footprint", "-p", str(os.getpid())]), ("vmmap", ["vmmap", "-summary", str(os.getpid())])):
        with open(f"{prefix}.{tool}.txt", "w") as f:
            subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)


def reuse(prefix):
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
    tools(prefix + ".after_alloc")
    del blocks
    freed = snap()
    alloc_mb = total * 2**20 / 1e6
    grew = after["footprint_mb"] - before["footprint_mb"]
    return {"alloc_mb": round(alloc_mb, 1), "footprint_growth_mb": round(grew, 1),
            "reused_mb": round(alloc_mb - grew, 1), "before": before, "after_alloc": after, "after_free": freed}
