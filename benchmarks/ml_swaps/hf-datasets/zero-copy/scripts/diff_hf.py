import collections, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
a = open(f"{C.OUT}/hash_A_canon.bin", "rb").read()
b = open(f"{C.OUT}/hash_{sys.argv[1]}_canon.bin", "rb").read()
bad = [i for i in range(len(a) // 32) if a[32*i:32*i+32] != b[32*i:32*i+32]]
print("mismatched records", len(bad), "first", bad[:5], "last", bad[-3:])
rows, _, _ = C.load_list()
ds, _, _ = C.load(sys.argv[1], sys.argv[2])
kinds = collections.Counter()
ex = {}
for i in bad:
    r, h = rows[i], C.strip_none(ds[i])
    for k in sorted(set(r) | set(h)):
        if r.get(k) != h.get(k):
            if k == "conversations":
                for j, (u, v) in enumerate(zip(r[k], h[k])):
                    if u != v:
                        kk = ("conv", tuple(sorted(set(u) ^ set(v))), tuple(x for x in u if u.get(x) != v.get(x)))
                        kinds[kk] += 1
                        ex.setdefault(kk, (i, {x: str(u.get(x))[:80] for x in u}, {x: str(v.get(x))[:80] for x in v}))
            else:
                kk = (k, type(r.get(k)).__name__)
                kinds[kk] += 1
                ex.setdefault(kk, (i, repr(r.get(k))[:80], repr(h.get(k))[:80]))
for k, v in kinds.items():
    print(k, v, ex[k])
