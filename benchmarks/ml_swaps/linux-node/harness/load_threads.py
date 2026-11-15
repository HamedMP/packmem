"""Peak RssAnon / RssFile / VmRSS of packmem.load_json, sampled from outside the loading process.

usage: load_threads.py PYTHON FILE THREADS RUNS OUT.jsonl [env|kw]
env (default) sets PACKMEM_THREADS=THREADS; kw calls load_json(FILE, threads=THREADS) with the environment unchanged.
Each run starts a fresh child (PACKMEM_THREADS=THREADS) that imports packmem, signals ready, loads FILE,
reports its own load time and status after the call, then waits. The parent reads /proc/<child>/status
every 2 ms from the signal until the child reports, so a held GIL in the child cannot starve the sampler.
"""
import json, os, subprocess, sys, time

py, path, threads, runs, out = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
mode = sys.argv[6] if len(sys.argv) > 6 else "env"

CHILD = r"""
import json, os, sys, time
import packmem
def status():
    d = {}
    for line in open("/proc/self/status"):
        k, _, v = line.partition(":")
        if k in ("RssAnon", "RssFile", "VmRSS", "VmHWM"):
            d[k] = int(v.split()[0]) / 1024
    return d
before = status()
print("READY", flush=True)
t0 = time.perf_counter()
t = packmem.load_json(sys.argv[1], threads=int(sys.argv[2])) if sys.argv[3] == "kw" else packmem.load_json(sys.argv[1])
dt = time.perf_counter() - t0
after = status()
print(json.dumps({"load_s": round(dt, 3), "rows": len(t), "nbytes": t.nbytes, "before": before, "after": after,
                  "packmem": packmem.__version__}), flush=True)
sys.stdin.readline()
"""

KEYS = ("RssAnon", "RssFile", "VmRSS")


def read(pid):
    d = {}
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                k, _, v = line.partition(":")
                if k in KEYS:
                    d[k] = int(v.split()[0]) / 1024
    except (FileNotFoundError, ProcessLookupError):
        pass
    return d


def loadavg():
    return open("/proc/loadavg").read().split()[:3]


with open(out, "a") as f:
    for r in range(1, runs + 1):
        env = dict(os.environ, PACKMEM_THREADS=threads) if mode == "env" else {k: v for k, v in os.environ.items() if k != "PACKMEM_THREADS"}
        p = subprocess.Popen([py, "-I", "-c", CHILD, path, threads, mode], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                             env=env)
        assert p.stdout.readline().strip() == "READY"
        os.set_blocking(p.stdout.fileno(), False)
        peak = {k: 0.0 for k in KEYS}
        samples, buf, l0 = 0, "", loadavg()
        while True:
            s = read(p.pid)
            for k in KEYS:
                peak[k] = max(peak[k], s.get(k, 0.0))
            samples += 1
            try:
                chunk = os.read(p.stdout.fileno(), 65536).decode()
            except BlockingIOError:
                chunk = ""
            if chunk:
                buf += chunk
                if buf.endswith("\n"):
                    break
            time.sleep(0.002)
        res = json.loads(buf.strip().splitlines()[-1])
        p.stdin.write("\n"); p.stdin.flush(); p.wait()
        row = {"threads": int(threads), "mode": mode, "run": r, "samples": samples, "load_start": l0, "load_end": loadavg(),
               "peak_mib": {k: round(v, 1) for k, v in peak.items()},
               "after_mib": {k: round(v, 1) for k, v in res["after"].items()},
               "before_mib": {k: round(v, 1) for k, v in res["before"].items()},
               **{k: res[k] for k in ("load_s", "rows", "nbytes", "packmem")}}
        f.write(json.dumps(row) + "\n"); f.flush()
        print(json.dumps(row), flush=True)
