import subprocess, sys, time, json, mem
label = sys.argv[1]; cmd = sys.argv[2]
t = time.perf_counter(); p = subprocess.run(cmd, shell=True, capture_output=True, text=True); el = time.perf_counter() - t
print(json.dumps({"run": label, "seconds": round(el, 2), "peak_mb": round(mem.child_peak(), 1), "exit": p.returncode, "out": (p.stdout.strip() or p.stderr.strip())[-160:]}))
