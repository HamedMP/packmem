"""packmem v2: load_json + id normalize (as arm C), then save() the table once to C.PKM_SAVED for the V2O arm."""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

import packmem  # noqa: E402

os.makedirs(os.path.dirname(C.PKM_SAVED), exist_ok=True)
t, t_load, t_norm = C.load_pm()
t0 = C.perf()
t.save(C.PKM_SAVED)
save_s = C.perf() - t0
h = hashlib.sha256()
with open(C.PKM_SAVED, "rb") as f:
    while b := f.read(1 << 24):
        h.update(b)
o = packmem.open(C.PKM_SAVED)
print(json.dumps({"load_s": t_load, "norm_s": t_norm, "save_s": save_s, "nbytes": t.nbytes,
                  "to_bytes_len": len(t.to_bytes()), "file": C.file_info(C.PKM_SAVED), "sha256": h.hexdigest(),
                  "open_len": len(o), "open_eq": o == t, "open_shared": o.shared, "version": packmem.__version__}))
