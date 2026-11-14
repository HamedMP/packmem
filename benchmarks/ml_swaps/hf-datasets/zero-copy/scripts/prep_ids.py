"""Write the HF workaround input: the same JSON array with every id as a string, nothing else changed."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
t0 = time.perf_counter()
rows, _, _ = C.load_list()
with open(C.DATA_IDSTR, "w") as f:
    json.dump(rows, f, indent=2)
print(json.dumps({"s": time.perf_counter() - t0, "bytes": os.path.getsize(C.DATA_IDSTR), "orig_bytes": os.path.getsize(C.DATA)}))
