"""Run every variant in fresh processes, several times each, and write one summary line per variant.

usage: python run_all.py <data_dir> <out.jsonl> [reps]
Each numeric field becomes [median, min, max] over the repetitions. Non-numeric answers must
agree across repetitions.
"""
import json, pathlib, platform, statistics, subprocess, sys, time

here = pathlib.Path(__file__).resolve().parent
data, out, reps = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 5

RUNS = [("bench.py", [v, ds]) for ds in ("flights", "nginx")
        for v in ("list", "packmem", "packmem_speed", "packmem_file", "packmem_wrap", "pandas", "pandas_arrow", "polars")]
RUNS += [("bench_io.py", [v]) for v in ("csv_list", "csv_packmem", "csv_packmem_wrap", "sqlite_list", "sqlite_packmem")]


def machine():
    m = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()}
    if sys.platform == "darwin":
        for k in ("machdep.cpu.brand_string", "hw.memsize", "hw.perflevel0.physicalcpu", "hw.perflevel1.physicalcpu"):
            m[k] = subprocess.run(["sysctl", "-n", k], capture_output=True, text=True).stdout.strip()
    for pkg in ("packmem", "pandas", "polars", "pyarrow"):
        try: m[pkg] = __import__("importlib.metadata").metadata.version(pkg)
        except Exception: m[pkg] = None
    return m


def spread(xs): return [round(statistics.median(xs), 3), round(min(xs), 3), round(max(xs), 3)]


def merge(rs):
    o = {}
    for k, v in rs[0].items():
        vals = [r[k] for r in rs]
        if k == "q":
            o[k] = {}
            for name in v:
                answers = {json.dumps(r["q"][name][1]) for r in rs}
                assert len(answers) == 1, (name, answers)
                o[k][name] = {"ms": spread([r["q"][name][0] for r in rs]), "answer": v[name][1]}
        elif isinstance(v, (int, float)) and not isinstance(v, bool) and k != "rows": o[k] = spread(vals)
        else:
            assert all(x == v for x in vals), (k, vals)
            o[k] = v
    return o


with open(out, "w") as f:
    f.write(json.dumps({"machine": machine(), "reps": reps, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")}) + "\n")
    for script, args in RUNS:
        rs = []
        for _ in range(reps):
            p = subprocess.run([sys.executable, str(here / script), *args], cwd=data, capture_output=True, text=True)
            if p.returncode != 0:
                sys.exit(f"{script} {args} failed:\n{p.stderr[-2000:]}")
            rs.append(json.loads(p.stdout.strip().splitlines()[-1]))
        line = merge(rs); f.write(json.dumps(line) + "\n"); f.flush()
        print(script, *args, "rss", line["rss_mb"][0], "footprint", line["footprint_mb"][0], "load", line["load_s"][0], flush=True)
