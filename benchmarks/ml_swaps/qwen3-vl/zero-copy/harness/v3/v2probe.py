"""Read-only and file-lifetime behaviour of the zero-copy wheel (share() v2, save/open), on a small table.
Each case runs in its own child process, so a crash is reported as an exit code rather than ending the probe.

usage: v2probe.py OUT_JSON
"""
import json, os, pickle, subprocess, sys, tempfile

CASES = r'''
import os, pickle, sys, json, tempfile, packmem
case, d = sys.argv[1], sys.argv[2]
rows = [{"id": i, "conversations": [{"from": "human", "value": "q%d" % i}], "data_path": "/x"} for i in range(5000)]

def ops(t):
    out = {}
    for name, fn in (("setitem", lambda: t.__setitem__(0, t[0])), ("append", lambda: t.append(t[0])),
                     ("set_column", lambda: t.set_column("data_path", "y")),
                     ("lazy_row_write", lambda: next(t.lazy()).__setitem__("data_path", "y"))):
        try:
            fn(); out[name] = "ok"
        except Exception as e:
            out[name] = type(e).__name__ + ": " + str(e)[:90]
    return out

r = {}
if case == "share_attach":
    t = packmem.Table(rows).share()
    blob = pickle.dumps(t)
    r["pickle_bytes"] = len(blob); r["mode"] = oct(os.stat(t._share.path).st_mode & 0o777)
    child = subprocess = __import__("subprocess")
    p = child.run([sys.executable, "-I", "-c", "import pickle,sys,json; t=pickle.loads(sys.stdin.buffer.read()); "
                   "print(json.dumps({'len': len(t), 'shared': t.shared, 'row': t[4999]['id'], 're_pickle': len(pickle.dumps(t))}))"],
                  input=blob, capture_output=True)
    r["child"] = p.stdout.decode().strip() or p.stderr.decode()[-300:]
    back = pickle.loads(blob)
    r["attached_ops"] = ops(back)
    c = back.copy(); c.append(c[0]); r["copy_len"] = len(c); r["copy_shared"] = c.shared
    path = t._share.path
    del back, c
    t.unshare(); r["exists_after_unshare"] = os.path.exists(path)
    try:
        pickle.loads(blob); r["loads_after_unshare"] = "ok"
    except Exception as e:
        r["loads_after_unshare"] = type(e).__name__ + ": " + str(e)[:120]
elif case == "attached_survives_owner":
    t = packmem.Table(rows).share(); blob = pickle.dumps(t)
    back = pickle.loads(blob)
    t.unshare()  # removes the file while 'back' still maps it
    r["read_after_owner_unshare"] = [back[0]["id"], back[4999]["id"], len(list(back))]
elif case == "open":
    path = os.path.join(d, "probe-open.pkm")
    packmem.Table(rows).save(path)
    r["mode"] = oct(os.stat(path).st_mode & 0o777)
    o = packmem.open(path)
    r["shared"] = o.shared; r["len"] = len(o); r["pickle_bytes"] = len(pickle.dumps(o))
    r["ops"] = ops(o)
    os.unlink(path)
    r["read_after_unlink"] = [o[0]["id"], o[4999]["id"]]
    try:
        pickle.loads(pickle.dumps(o)); r["loads_after_unlink"] = "ok"
    except Exception as e:
        r["loads_after_unlink"] = type(e).__name__ + ": " + str(e)[:120]
elif case == "open_unshare_then_write":
    path = os.path.join(d, "probe-open2.pkm")
    packmem.Table(rows).save(path)
    o = packmem.open(path)
    o.unshare()
    r["shared_after_unshare"] = o.shared
    r["exists_after_unshare"] = os.path.exists(path)
    r["ops_after_unshare"] = ops(o)
    r["row0_after"] = o[0]
    os.unlink(path) if os.path.exists(path) else None
elif case == "cleanup_stale":
    r["removed"] = packmem.cleanup_stale()
print(json.dumps(r))
'''


def main(out):
    d = tempfile.mkdtemp(prefix="v2probe-")
    res = {}
    for case in ("share_attach", "attached_survives_owner", "open", "open_unshare_then_write", "cleanup_stale"):
        p = subprocess.run([sys.executable, "-I", "-c", CASES, case, d], capture_output=True, text=True)
        res[case] = {"exit": p.returncode, "out": json.loads(p.stdout) if p.stdout.strip().startswith("{") else p.stdout[-300:],
                     "stderr": p.stderr[-400:]}
    res["leftover_in_probe_dir"] = os.listdir(d)
    json.dump(res, open(out, "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
