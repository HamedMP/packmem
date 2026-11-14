"""Page-cache control without sudo: drop | warm | stat over the given files."""
import ctypes
import json
import os
import sys

libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
PAGE = os.sysconf("SC_PAGE_SIZE")


def resident(path):
    size = os.path.getsize(path)
    if size == 0:
        return 0, 0
    fd = os.open(path, os.O_RDONLY)
    try:
        addr = libc.mmap(None, size, 1, 1, fd, 0)
        if addr in (None, ctypes.c_void_p(-1).value):
            raise OSError(ctypes.get_errno(), "mmap")
        pages = (size + PAGE - 1) // PAGE
        vec = (ctypes.c_ubyte * pages)()
        if libc.mincore(addr, size, vec) != 0:
            raise OSError(ctypes.get_errno(), "mincore")
        libc.munmap(addr, size)
        return sum(b & 1 for b in vec) * PAGE, size
    finally:
        os.close(fd)


def main():
    op, files = sys.argv[1], sys.argv[2:]
    for p in files:
        if op == "drop":
            fd = os.open(p, os.O_RDONLY)
            os.fsync(fd)
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            os.close(fd)
        elif op == "warm":
            with open(p, "rb") as f:
                while f.read(1 << 24):
                    pass
    res = {os.path.basename(p): resident(p) for p in files}
    tot_r = sum(r for r, _ in res.values())
    tot_s = sum(s for _, s in res.values())
    print(json.dumps({"op": op, "resident_bytes": tot_r, "size_bytes": tot_s,
                      "resident_frac": round(tot_r / tot_s, 4) if tot_s else None}))


if __name__ == "__main__":
    main()
