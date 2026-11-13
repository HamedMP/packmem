"""harness/verify.py, plus the same checks on the Table after a pickle round trip and after
Table.from_bytes(to_bytes())."""
import json, pickle, sys
import packmem
path = sys.argv[1]
ref = json.load(open(path))
t = packmem.load_json(path)
blob = pickle.dumps(t)
variants = {"load_json": t, "pickle_roundtrip": pickle.loads(blob), "from_bytes": packmem.Table.from_bytes(t.to_bytes())}
out = {"records": len(ref), "pickle_bytes": len(blob), "nbytes": t.nbytes}
for name, tab in variants.items():
    assert len(ref) == len(tab), (name, len(ref), len(tab))
    bad = 0
    for i, r in enumerate(ref):
        p = tab[i]
        if p != r or list(p) != list(r) or type(p.get("id")) is not type(r.get("id")) or type(p.get("image")) is not type(r.get("image")) or json.dumps(p) != json.dumps(r):
            bad += 1
            if bad <= 3:
                print("MISMATCH", name, i, r, p)
    out[name + "_mismatches"] = bad
print(json.dumps(out))
