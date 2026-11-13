"""Fork 4 workers from a process holding the dataset, as DataLoader(num_workers=4) does with the fork
start method, have each read its share of records the way _get_item does, and report the memory each
worker had to copy (phys_footprint growth after fork)."""
import multiprocessing as mp, sys, time
sys.path.insert(0, sys.argv[1]); sys.path.insert(1, "$BENCH/llava-next/harness")
import llava_import, footprint
from types import SimpleNamespace
t = llava_import.load_train_module()
ds = t.LazySupervisedDataset("$BENCH/llava-next/data/mix.yaml", None, SimpleNamespace(early_mix_text=False))
W = 4

def work(w, q):
    base = footprint.footprint()[0]
    L = ds.list_data_dict
    n = 0
    for i in range(w, len(L), W):
        s = L[i]
        if "image" in s:
            n += len(L[i]["conversations"])
        _ = L[i].get("id", i)
    q.put((w, base, footprint.footprint()[0], footprint.footprint()[1]))

if __name__ == "__main__":
    ctx = mp.get_context("fork")
    q = ctx.Queue()
    parent = footprint.footprint()[0]
    t0 = time.perf_counter()
    ps = [ctx.Process(target=work, args=(w, q)) for w in range(W)]
    [p.start() for p in ps]
    res = sorted(q.get() for _ in ps)
    [p.join() for p in ps]
    el = time.perf_counter() - t0
    print(sys.argv[2], "parent footprint %.0f MB;" % parent, "per-worker footprint start->end:", [(round(r[1]), round(r[2])) for r in res],
          "sum %.0f MB; epoch pass %.1f s" % (sum(r[2] for r in res), el))
