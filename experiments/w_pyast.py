# real data: parse the Python stdlib sources into ASTs and keep them (compiler-like workload)
import ast,glob,sysconfig,time
trees=[]
for p in sorted(glob.glob(sysconfig.get_paths()["stdlib"]+"/*.py")):
    try: trees.append((p,open(p,encoding="utf8",errors="ignore").read(),ast.parse(open(p,encoding="utf8",errors="ignore").read())))
    except Exception: pass
print("ready",flush=True); time.sleep(600)
