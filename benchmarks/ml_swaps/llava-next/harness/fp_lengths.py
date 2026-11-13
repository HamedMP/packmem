import sys, time, os
sys.path.insert(0, sys.argv[1]); sys.path.insert(1, "$BENCH/llava-next/harness")
import llava_import, footprint
from types import SimpleNamespace
t = llava_import.load_train_module()
f0 = footprint.footprint()
ds = t.LazySupervisedDataset("$BENCH/llava-next/data/mix.yaml", None, SimpleNamespace(early_mix_text=False))
f1 = footprint.footprint()
L = ds.list_data_dict
def lengths(it):
    return [sum(len(c["value"].split()) for c in s["conversations"]) + (128 if "image" in s else 0) for s in it]
t0=time.perf_counter(); a = lengths(L); tp=time.perf_counter()-t0
tl = None
if hasattr(L, "lazy"):
    t0=time.perf_counter(); b = lengths(L.lazy()); tl=time.perf_counter()-t0; assert a==b
print(sys.argv[2], "footprint before %.0f after-load %.0f lifetime-max %.0f MB" % (f0[0], f1[0], footprint.footprint()[1]), "plain %.2f lazy %s" % (tp, tl))
