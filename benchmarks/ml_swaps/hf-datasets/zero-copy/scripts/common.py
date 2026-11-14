import glob
import hashlib
import json
import os
import time

ROOT = os.path.expanduser("~/packmem-hfbench")
DATA = f"{ROOT}/data/llava_v1_5_mix665k.json"
DATA_IDSTR = f"{ROOT}/data/mix665k.idstr.json"
PARQUET = f"{ROOT}/data/mix665k.zstd.parquet"
HF = f"{ROOT}/hf"
OUT = os.environ.get("PMB_OUT", f"{ROOT}/out")
PKM_SAVED = f"{ROOT}/pkm/mix665k.pkm"
PKM_DISK_DIR = f"{ROOT}/pkmshare"
EXTRA = {}

perf = time.perf_counter


def features(conv_json=False):
    from datasets import Features, Json, List, Value

    turn = {
        "from": Value("string"),
        "value": Value("string"),
        "text": Value("string"),
        "markdown": {"type": Value("string"), "index": Value("int64"), "answer": Value("string")},
    }
    return Features({
        "id": Value("string"),
        "image": Value("string"),
        "model": Value("string"),
        "conversations": List(Json()) if conv_json else List(turn),
    })


def load_list():
    t0 = perf()
    with open(DATA, "rb") as f:
        rows = json.load(f)
    t1 = perf()
    for r in rows:
        r["id"] = str(r["id"])
    return rows, t1 - t0, perf() - t1


def load_pm():
    import packmem

    t0 = perf()
    t = packmem.load_json(DATA)
    t1 = perf()
    t.set_column("id", [str(v) for v in t.column("id")])
    return t, t1 - t0, perf() - t1


def load_hf(arm, cache, src=None):
    import datasets

    datasets.disable_progress_bars()
    datasets.logging.set_verbosity_error()
    src = src or DATA_IDSTR
    t0 = perf()
    if arm in ("B1", "B2"):
        ds = datasets.load_dataset("json", data_files=src, features=features(), split="train",
                                   cache_dir=cache, keep_in_memory=arm == "B2")
    elif arm == "B4":
        ds = datasets.load_dataset("json", data_files=src, features=features(conv_json=True),
                                   split="train", cache_dir=cache)
    elif arm == "B3":
        ds = datasets.load_dataset("parquet", data_files=PARQUET, split="train", cache_dir=cache)
    else:
        raise ValueError(arm)
    return ds, perf() - t0, 0.0


class ConstSeq:
    """Floor arm: same libraries imported, no data held; every index returns one small record."""

    def __init__(self, n):
        self.n = n
        self.rec = {"id": "0", "conversations": [{"from": "human", "value": "x"}]}

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        return self.rec


def file_info(path):
    st = os.stat(path)
    return {"path": path, "size": st.st_size, "mode": oct(st.st_mode & 0o777),
            "fs": "tmpfs" if path.startswith("/dev/shm/") else "disk"}


def load_v2(arm):
    import packmem

    if arm == "V2O":
        t0 = perf()
        t = packmem.open(PKM_SAVED)
        EXTRA["open_s"] = perf() - t0
        EXTRA["file"] = file_info(PKM_SAVED)
        return t, EXTRA["open_s"], 0.0
    t, t_load, t_norm = load_pm()
    t0 = perf()
    t.share(dir=PKM_DISK_DIR if arm == "V2D" else None)
    EXTRA["share_s"] = perf() - t0
    EXTRA["file"] = file_info(t._share.path)
    return t, t_load, t_norm


def load(arm, cache=None):
    if arm in ("V2S", "V2D", "V2O"):
        return load_v2(arm)
    if arm == "E0":  # floor matched to the list / packmem parents: no datasets or pyarrow import
        import packmem  # noqa: F401

        return ConstSeq(665298), 0.0, 0.0
    if arm == "E":
        import datasets  # noqa: F401
        import packmem  # noqa: F401
        import pyarrow  # noqa: F401

        return ConstSeq(665298), 0.0, 0.0
    if arm == "A":
        return load_list()
    if arm == "C":
        return load_pm()
    return load_hf(arm, cache)


def strip_none(o):
    if isinstance(o, dict):
        return {k: strip_none(v) for k, v in o.items() if v is not None}
    if isinstance(o, list):
        return [strip_none(v) for v in o]
    return o


def record_hash(r):
    return hashlib.sha256(json.dumps(r, sort_keys=True).encode()).digest()


def conv_hash(r):
    s = "\x1e".join(c["from"] + "\x1f" + c["value"] for c in r["conversations"])
    return hashlib.sha256(s.encode()).hexdigest()


def collate(batch):
    return [conv_hash(r) for r in batch]


def _kv(path):
    d = {}
    with open(path) as f:
        for line in f:
            p = line.split()
            if len(p) == 3 and p[2] == "kB":
                d[p[0].rstrip(":")] = int(p[1]) * 1024
    return d


ROLLUP_KEYS = ("Rss", "Pss", "Pss_Anon", "Pss_File", "Pss_Shmem", "Shared_Clean", "Shared_Dirty",
               "Private_Clean", "Private_Dirty", "Anonymous")


def rollup(pid="self"):
    d = _kv(f"/proc/{pid}/smaps_rollup")
    r = {k: d.get(k, 0) for k in ROLLUP_KEYS}
    r["USS"] = r["Private_Clean"] + r["Private_Dirty"]
    return r


def arrow_maps(pid="self"):
    tot = {"Rss": 0, "Pss": 0, "Private": 0, "Shared": 0, "Size": 0}
    cur = None
    with open(f"/proc/{pid}/smaps") as f:
        for line in f:
            p = line.split()
            if not p:
                continue
            if "-" in p[0] and not p[0].endswith(":"):
                cur = p[5] if len(p) >= 6 else ""
                continue
            if cur and cur.endswith(".arrow") and len(p) == 3 and p[2] == "kB":
                k = p[0].rstrip(":")
                v = int(p[1]) * 1024
                if k in ("Rss", "Pss", "Size"):
                    tot[k] += v
                elif k.startswith("Private_"):
                    tot["Private"] += v
                elif k.startswith("Shared_"):
                    tot["Shared"] += v
    return tot


def mem():
    import resource
    import sys

    m = rollup()
    m["arrow_map"] = arrow_maps()
    m["maxrss"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    if "pyarrow" in sys.modules:
        m["pa_allocated"] = sys.modules["pyarrow"].total_allocated_bytes()
    return m


def arrow_files(d):
    files = sorted(glob.glob(f"{d}/**/*.arrow", recursive=True))
    return {os.path.relpath(f, d): os.path.getsize(f) for f in files}


MAP_KEYS = ("Rss", "Pss", "Shared_Clean", "Shared_Dirty", "Private_Clean", "Private_Dirty")


def file_maps(pid="self", suffix=".pkm"):
    """Per-key sums over the mappings of files whose name ends in `suffix` (e.g. '.pkm', '.arrow')."""
    tot = dict.fromkeys(MAP_KEYS, 0)
    tot["paths"] = []
    cur = None
    with open(f"/proc/{pid}/smaps") as f:
        for line in f:
            p = line.split()
            if not p:
                continue
            if "-" in p[0] and not p[0].endswith(":"):
                cur = " ".join(p[5:]) if len(p) >= 6 else ""
                if cur.endswith(suffix) and cur not in tot["paths"]:
                    tot["paths"].append(cur)
                continue
            if cur and cur.endswith(suffix) and len(p) == 3 and p[2] == "kB":
                k = p[0].rstrip(":")
                if k in tot:
                    tot[k] += int(p[1]) * 1024
    return tot
