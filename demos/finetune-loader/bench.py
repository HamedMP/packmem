"""Run every variant several times, interleaved, and save each result in results/.

    python bench.py --python /path/to/venv-0.1.2/bin/python --python-next /path/to/venv-main/bin/python

--python runs list, hf and packmem with packmem as released; --python-next, if given, runs packmem and
packmem-open with a build that has packmem.open (main, until the next release). Before each measured run it waits
for the 1-minute load average to fall to --max-load, for at most 10 minutes, and records the load it started at.
Each mode's cache (the Arrow files, the .pkm file) is built once first, like a training job's first run.
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def wait_for_quiet(max_load, limit_s=600):
    t0 = time.time()
    while os.getloadavg()[0] > max_load and time.time() - t0 < limit_s:
        time.sleep(15)


def run(python, args):
    p = subprocess.run([python, os.path.join(HERE, "run.py"), *args], capture_output=True, text=True, cwd=HERE)
    if p.returncode != 0:
        sys.exit(f"run.py {' '.join(args)} failed:\n{p.stderr[-2000:]}")
    return json.loads(p.stdout.strip().splitlines()[-1])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--python-next")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--fork-reps", type=int, default=0, help="also run each variant this many times with fork")
    ap.add_argument("--max-load", type=float, default=6.0)
    ap.add_argument("--file")
    ap.add_argument("--samples", type=int, default=20_000)
    a = ap.parse_args()

    variants = [(a.python, "floor"), (a.python, "list"), (a.python, "hf"), (a.python, "packmem")]
    if a.python_next:
        variants += [(a.python_next, "packmem"), (a.python_next, "packmem-open")]
    common = ["--samples", str(a.samples), *(["--file", a.file] if a.file else [])]

    for py in {py for py, _ in variants}:  # load every library once, untimed
        subprocess.run([py, "-c", "import packmem, torch, datasets, psutil"], check=True, capture_output=True)
    prepared = []
    for py, mode in variants:
        if mode in ("hf", "packmem-open"):
            prepared.append(run(py, ["--mode", mode, "--prepare", *common]))
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    with open(os.path.join(HERE, "results", "prepare.json"), "w") as f:
        json.dump(prepared, f, indent=2)

    plan = [("spawn", r) for r in range(a.reps)] + [("fork", r) for r in range(a.fork_reps)]
    for start, rep in plan:
        for py, mode in variants if rep % 2 == 0 else variants[::-1]:  # alternate the order so drift hits every variant
            wait_for_quiet(a.max_load)
            r = run(py, ["--mode", mode, "--start", start, *common])
            print(f"{mode:13} {r['versions'].get('packmem', ''):11} {start:6} load {r['loadavg_at_start']:4.1f}  "
                  f"peak {r['peak_sum'][r['charged_metric']]:7.0f} MB  first batch {r['first_batch_s']:5.2f} s", flush=True)


if __name__ == "__main__":
    main()
