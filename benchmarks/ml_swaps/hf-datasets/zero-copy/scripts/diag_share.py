"""diag_share.py [norm|nonorm]: where the parent's anonymous memory goes across load_json -> set_column -> share()."""
import ctypes
import gc
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

import packmem  # noqa: E402

MB = 1e6
out = {"mode": sys.argv[1], "version": packmem.__version__}


def snap(tag):
    gc.collect()
    r = C.rollup()
    out[tag] = {k: round(r[k] / MB, 1) for k in ("Pss_Anon", "USS", "Rss", "Pss_Shmem")}


snap("start")
t = packmem.load_json(C.DATA)
snap("after_load_json")
if sys.argv[1] == "norm":
    t.set_column("id", [str(v) for v in t.column("id")])
    snap("after_set_column")
t.share()
snap("after_share")
libc = ctypes.CDLL("libc.so.6")
out["malloc_trim_ret"] = libc.malloc_trim(0)
snap("after_malloc_trim")
out["len"] = len(t)
print(json.dumps(out))
