"""Run bench_polars_tuned.py for every variant and data set in fresh processes; write median, minimum, maximum.

usage: python run_polars_tuned.py <data_dir> <work_dir> <out.jsonl> [reps] [dataset ...]
<work_dir> receives the tuned parquet files, the schemas and flights_big.jsonl: nycflights13 repeated
ten times (3.37 million rows), each copy with its year shifted so the copies are not identical.
Answers must agree across repetitions and, numerically, with the list of dicts.
A "+decay0" variant runs the same code with _RJEM_MALLOC_CONF=dirty_decay_ms:0,muzzy_decay_ms:0, so
polars' jemalloc returns freed pages to the OS at once instead of keeping them.
Set PM_VARIANTS=a,b,... to run a subset.
"""
import json, os, pathlib, platform, statistics, subprocess, sys, time

here = pathlib.Path(__file__).resolve().parent
data, work, out = sys.argv[1], os.path.abspath(sys.argv[2]), os.path.abspath(sys.argv[3])   # children run with cwd=data
reps = int(sys.argv[4]) if len(sys.argv) > 4 else 5
datasets = sys.argv[5:] or ["flights", "nginx", "logs", "flights_big"]
VARIANTS = ["list", "packmem", "polars", "polars_rechunk", "polars_tuned", "polars_tuned_scan", "polars_parquet",
            "polars+decay0", "polars_tuned+decay0", "polars_tuned_scan+decay0", "polars_parquet+decay0"]
if os.environ.get("PM_VARIANTS"): VARIANTS = os.environ["PM_VARIANTS"].split(",")
DECAY0 = {"_RJEM_MALLOC_CONF": "dirty_decay_ms:0,muzzy_decay_ms:0"}
COPIES = 10
os.makedirs(work, exist_ok=True)


def make_big():
    dst = os.path.join(work, "flights_big.jsonl")
    if os.path.exists(dst): return
    src = [json.loads(l) for l in open(os.path.join(data, "flights.jsonl"))]
    with open(dst + ".tmp", "w") as f:
        for k in range(COPIES):
            for r in src:
                r = dict(r); r["year"] += k
                r["time_hour"] = str(int(r["time_hour"][:4]) + k) + r["time_hour"][4:]
                f.write(json.dumps(r, separators=(",", ":")) + "\n")
    os.replace(dst + ".tmp", dst)


def machine():
    m = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()}
    if sys.platform == "darwin":
        for k in ("machdep.cpu.brand_string", "hw.memsize"):
            m[k] = subprocess.run(["sysctl", "-n", k], capture_output=True, text=True).stdout.strip()
    for pkg in ("packmem", "polars", "pyarrow"):
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


def run(variant, *args):
    base, _, opt = variant.partition("+")
    env = {**os.environ, **(DECAY0 if opt == "decay0" else {})}
    p = subprocess.run([sys.executable, str(here / "bench_polars_tuned.py"), base, *args], cwd=data, capture_output=True, text=True, env=env)
    if p.returncode != 0: sys.exit(f"{variant} {args} failed:\n{p.stderr[-2000:]}")
    r = json.loads(p.stdout.strip().splitlines()[-1]); r["variant"] = variant
    return r


if "flights_big" in datasets: make_big()
with open(out, "w") as f:
    f.write(json.dumps({"machine": machine(), "reps": reps, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")}) + "\n")
    for ds in datasets:
        prep = run("prep", ds, work); f.write(json.dumps(prep) + "\n"); print(json.dumps(prep), flush=True)
        ref = None
        for v in VARIANTS:
            line = merge([run(v, ds, work) for _ in range(reps)])
            if v == "list": ref = {k: q["answer"] for k, q in line["q"].items()}
            for k, q in line["q"].items():
                if ref and k in ref: assert ref[k] == q["answer"], (ds, v, k, ref[k], q["answer"])
            f.write(json.dumps(line) + "\n"); f.flush()
            print(ds, v, "rss", line["rss_mb"][0], "footprint", line["footprint_mb"][0], "load", line["load_s"][0], flush=True)
