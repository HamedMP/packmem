"""Per file: hash of the decoded rows (sorted keys), hash of Table.to_json(), nbytes, and how many \\u escapes
the source and to_json() contain. Run under each wheel and compare.

usage: nestcheck.py OUT_JSON FILE...
"""
import hashlib, json, os, sys, time

import packmem

res = {"packmem": packmem.__version__, "threads": os.environ.get("PACKMEM_LOAD_THREADS"), "files": {}}
for path in sys.argv[2:]:
    t0 = time.perf_counter()
    t = packmem.load_jsonl(path) if path.endswith(".jsonl") else packmem.load_json(path)
    load_s = time.perf_counter() - t0
    rows = hashlib.sha256()
    for r in t:
        rows.update(json.dumps(r, sort_keys=True).encode())
        rows.update(b"\n")
    out = t.to_json()
    src = open(path, "rb").read()
    res["files"][os.path.join(os.path.basename(os.path.dirname(os.path.dirname(path))), os.path.basename(path))] = {
        "n": len(t), "load_s": round(load_s, 2), "nbytes": t.nbytes, "rows_sha": rows.hexdigest(),
        "to_json_sha": hashlib.sha256(out).hexdigest(), "to_json_bytes": len(out),
        "src_u_escapes": src.count(b"\\u"), "to_json_u_escapes": out.count(b"\\u"),
        "src_slash_escapes": src.count(b"\\/"), "to_json_slash_escapes": out.count(b"\\/"),
    }
    del t, out, src
json.dump(res, open(sys.argv[1], "w"), indent=1)
print(json.dumps(res, indent=1))
