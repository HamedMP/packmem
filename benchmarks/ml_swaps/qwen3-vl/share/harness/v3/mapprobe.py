"""What a worker pays to unpickle the table, and what a read-only file mapping counts as on macOS.

usage: mapprobe.py parent ANNOTATION_JSON OUT_DIR
  The parent loads the table (with data_path set as in the patch), pickles it plain and shared, and runs one
  fresh child per kind. Each child reads the pickle bytes from a file (as a spawn worker reads them from its
  pipe), unpickles them, and reports phys_footprint (current and lifetime peak) and RSS around each step.
  The 'mmap' child maps the .pkm read-only, reads every page, and runs `footprint` and `vmmap -summary` on
  itself while the mapping is held.
"""
import ctypes, gc, json, mmap, os, pickle, subprocess, sys, time

_libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")


def fp():
    buf = (ctypes.c_uint64 * 64)()
    _libc.proc_pid_rusage(os.getpid(), 4, buf)
    return {"cur_mb": round(buf[2 + 7] / 1e6, 1), "peak_mb": round(buf[2 + 28] / 1e6, 1), "rss_mb": round(rss() / 1e6, 1)}


def rss():
    import psutil
    return psutil.Process().memory_info().rss


def tools(tag, out_dir):
    for tool, cmd in (("footprint", ["footprint", "-p", str(os.getpid())]), ("vmmap", ["vmmap", "-summary", str(os.getpid())])):
        with open(os.path.join(out_dir, f"{tag}.{tool}.txt"), "w") as f:
            subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT)


def child(kind, arg, out_dir):
    import packmem  # noqa: F401
    r = {"kind": kind, "start": fp()}
    if kind == "mmap":
        with open(arg, "rb") as f:
            m = mmap.mmap(f.fileno(), 0, prot=mmap.PROT_READ)
        r["mapped"] = fp()
        s = 0
        for off in range(0, len(m), 16384):
            s += m[off]
        r["mapped_touched"] = fp()
        tools("mmap_held", out_dir)
        m.close()
        r["unmapped"] = fp()
    else:
        blob = open(arg, "rb").read()  # our own pickle, written by the parent below
        r["blob_bytes"] = len(blob)
        r["blob_read"] = fp()
        t0 = time.perf_counter()
        t = pickle.loads(blob)
        r["loads_s"] = round(time.perf_counter() - t0, 3)
        r["loaded"] = fp()
        del blob
        gc.collect()
        r["blob_dropped"] = fp()
        r["rows"] = len(t)
        r["row0_ok"] = t[0]["data_path"] == "/datasets/llava/images"
        tools(f"{kind}_loaded", out_dir)
    print(json.dumps(r))


def parent(ann, out_dir):
    import packmem
    os.makedirs(out_dir, exist_ok=True)
    t = packmem.load_json(ann)
    t.set_column("data_path", "/datasets/llava/images")
    plain = os.path.join(out_dir, "plain.pickle")
    with open(plain, "wb") as f:
        f.write(pickle.dumps(t))
    t.share()
    shared = os.path.join(out_dir, "shared.pickle")
    with open(shared, "wb") as f:
        f.write(pickle.dumps(t))
    res = {"pkm": t._share.path, "pkm_bytes": os.path.getsize(t._share.path), "plain_pickle_bytes": os.path.getsize(plain),
           "shared_pickle_bytes": os.path.getsize(shared)}
    for kind, arg in (("plain", plain), ("shared", shared), ("mmap", t._share.path)):
        p = subprocess.run([sys.executable, "-I", os.path.abspath(__file__), "child", kind, arg, out_dir],
                           capture_output=True, text=True)
        res[kind] = json.loads(p.stdout) if p.returncode == 0 else {"error": p.stderr[-2000:]}
    os.unlink(plain)
    os.unlink(shared)
    json.dump(res, open(os.path.join(out_dir, "mapprobe.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    if sys.argv[1] == "parent":
        parent(sys.argv[2], sys.argv[3])
    else:
        child(sys.argv[2], sys.argv[3], sys.argv[4])
