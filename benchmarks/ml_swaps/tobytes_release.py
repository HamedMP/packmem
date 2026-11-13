"""Does the footprint left behind by Table.to_bytes() come back, and when?"""
import ctypes, gc, os, sys, time
import packmem
l = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
def fp():
    b = (ctypes.c_uint64 * 64)(); l.proc_pid_rusage(os.getpid(), 4, b); return round(b[9] / 2**20)
t = packmem.load_json(sys.argv[1]); gc.collect()
print("after load", fp(), "MiB; nbytes", t.nbytes >> 20)
for i in range(4):
    b = t.to_bytes(); del b
print("after 4 x to_bytes", fp())
prev = 0
for s in (1, 5, 15, 30, 60):
    time.sleep(s - prev); prev = s
    print(f"idle {s:>2} s", fp())
b = bytearray(1500 << 20); b[::4096] = b"x" * len(b[::4096]); del b   # unrelated 1.5 GiB allocation
print("after an unrelated 1.5 GiB allocation and free", fp())
for i in range(4):
    b = t.to_bytes(); del b
print("after 4 more x to_bytes", fp())
