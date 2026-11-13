"""What spawn/forkserver DataLoader workers need: the dataset must pickle."""
import json, pickle, sys, time
sys.path.insert(0, sys.argv[1] + "/finetune")
import dataset as ds
import packmem
for name, raw in (("list", lambda p: json.load(open(p))), ("packmem", packmem.load_json)):
    d = ds.SupervisedDataset(raw(sys.argv[2]), None, None, None)
    t = time.perf_counter()
    try:
        n = len(pickle.dumps(d))
        print(name, "pickled", round(n / 2**20), "MB in", round(time.perf_counter() - t, 2), "s")
    except Exception as e:
        print(name, "pickle failed:", type(e).__name__, e)
