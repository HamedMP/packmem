"""Run phases.py under a 2 ms /proc sampler and attribute RssAnon peaks to phases.

usage: phasesample.py OUT.json PYTHON JSON [hint]
"""
import json, os, subprocess, sys, tempfile, time

out, py, path = sys.argv[1:4]; hint = sys.argv[4] if len(sys.argv) > 4 else "balanced"
mkf = tempfile.mktemp(suffix=".markers")
p = subprocess.Popen([py, "-I", os.path.join(os.path.dirname(__file__), "phases.py"), mkf, path, hint])
samples = []
while p.poll() is None:
    try:
        d = {}
        with open(f"/proc/{p.pid}/status") as f:
            for line in f:
                k, _, v = line.partition(":")
                if k in ("RssAnon", "RssFile", "VmHWM"):
                    d[k] = int(v.split()[0]) / 1024
        samples.append((time.time(), d.get("RssAnon", 0), d.get("RssFile", 0), d.get("VmHWM", 0)))
    except (FileNotFoundError, ProcessLookupError):
        break
    time.sleep(0.002)
rc = p.wait()
marks = [l.split() for l in open(mkf)]; os.remove(mkf)
phases = {}
for t, name, what in marks:
    phases.setdefault(name, {})[what] = float(t)
res = {}
for name, se in phases.items():
    if "start" not in se: continue
    a, b = se["start"], se["end"]
    win = [s for s in samples if a <= s[0] <= b]
    before = [s for s in samples if s[0] < a]
    start_anon = before[-1][1] if before else (win[0][1] if win else 0)
    if win:
        res[name] = {"secs": round(b - a, 3), "start_RssAnon": round(start_anon, 1), "peak_RssAnon": round(max(s[1] for s in win), 1),
                     "delta_peak": round(max(s[1] for s in win) - start_anon, 1), "end_RssAnon": round(win[-1][1], 1),
                     "peak_RssFile": round(max(s[2] for s in win), 1), "n_samples": len(win)}
json.dump({"python": py, "file": os.path.basename(path), "hint": hint, "PACKMEM_THREADS": os.environ.get("PACKMEM_THREADS"),
           "PACKMEM_NOSUBCOL": os.environ.get("PACKMEM_NOSUBCOL"), "rc": rc, "VmHWM_end": samples[-1][3] if samples else None,
           "phases": res}, open(out, "w"), indent=1)
