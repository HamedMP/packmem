import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import datasets
datasets.disable_progress_bars()
t0 = time.perf_counter()
try:
    ds = datasets.load_dataset("json", data_files=C.DATA, features=C.features(), split="train",
                               cache_dir=sys.argv[1], on_mixed_types=None)
    print(json.dumps({"ok": True, "s": time.perf_counter() - t0, "ids": ds[364100:364103]["id"] + ds[624610:624611]["id"], "maxrss": C.mem()["maxrss"]}))
except Exception as e:
    print(json.dumps({"ok": False, "s": time.perf_counter() - t0, "err": f"{type(e).__name__}: {str(e)[:600]}"}))
