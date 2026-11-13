"""How many rows before packmem uses less memory than the list it replaces?

usage: python crossover.py <jsonl file> [out.jsonl]
Loads the first N lines of the file as a list of dicts and as a packmem table, each in a fresh
process, and reports memory and load time for a range of N.
"""
import json, subprocess, sys

CHILD = r'''
import gc, itertools, json, sys, time
sys.path.insert(0, sys.argv[4]); import mem
kind, path, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
if kind == "packmem": import packmem
lines = list(itertools.islice(open(path), n))
gc.collect(); base = mem.footprint(); t0 = time.perf_counter()
rows = [json.loads(l) for l in lines] if kind == "list" else packmem.load_jsonl(lines)
dt = time.perf_counter() - t0; gc.collect()
print(json.dumps({"kind": kind, "rows": len(rows), "mb": round(mem.footprint() - base, 2), "load_ms": round(dt * 1e3, 2),
                  "packed_mb": round(rows.nbytes / 1e6, 3) if kind == "packmem" else None}))
'''

if __name__ == "__main__":
    import pathlib, statistics
    here = str(pathlib.Path(__file__).resolve().parent)
    path = sys.argv[1]; out = open(sys.argv[2], "w") if len(sys.argv) > 2 else None
    total = sum(1 for _ in open(path))
    print(f"{'rows':>9} {'list MB':>9} {'packmem MB':>11} {'packed MB':>10} {'ratio':>6} {'list ms':>8} {'packmem ms':>10}")
    for n in (100, 300, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000):
        if n > total: break
        r = {}
        for kind in ("list", "packmem"):
            runs = [json.loads(subprocess.run([sys.executable, "-c", CHILD, kind, path, str(n), here], capture_output=True, text=True, check=True).stdout) for _ in range(5)]
            r[kind] = {k: (statistics.median(x[k] for x in runs) if isinstance(runs[0][k], (int, float)) else runs[0][k]) for k in runs[0]}
        a, b = r["list"], r["packmem"]
        print(f"{n:>9} {a['mb']:>9.2f} {b['mb']:>11.2f} {b['packed_mb']:>10.3f} {a['mb'] / max(b['mb'], 0.01):>6.1f} {a['load_ms']:>8.1f} {b['load_ms']:>10.1f}")
        if out: out.write(json.dumps({"rows": n, "list": a, "packmem": b}) + "\n")
