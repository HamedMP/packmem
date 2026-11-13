import json, sys, time
import packmem
path = sys.argv[1]
ref = json.load(open(path))
t = packmem.load_json(path)
assert len(ref) == len(t), (len(ref), len(t))
bad = 0
kinds = {}
for i, r in enumerate(ref):
    p = t[i]
    if p != r or list(p) != list(r) or type(p.get("id")) is not type(r.get("id")) or type(p.get("image")) is not type(r.get("image")) or json.dumps(p) != json.dumps(r):
        bad += 1
        if bad <= 3:
            print("MISMATCH", i, r, p)
    k = type(r.get("image")).__name__
    kinds[k] = kinds.get(k, 0) + 1
print(json.dumps({"records": len(ref), "mismatches": bad, "image_types": kinds,
                  "int_ids": sum(isinstance(r["id"], int) for r in ref)}))
