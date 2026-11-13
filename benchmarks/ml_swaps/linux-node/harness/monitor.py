"""Run a command and sample memory of all its descendants from /proc/<pid>/smaps_rollup.

usage: monitor.py OUT.jsonl INTERVAL_S MIN_AVAIL_GB -- cmd...
Reads the processes in parallel threads (smaps_rollup of a 4 GB process takes ~0.15 s).
Each line: {"t", "avail_kb", "dt" (sampling cost), "p": [[pid, ppid, role, rank, rss, pss, pss_anon, uss, swap_pss], ...]} (kB).
Kills the command's process group if MemAvailable falls below MIN_AVAIL_GB.
"""
import json
import os
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

FIELDS = ("Rss", "Pss", "Pss_Anon", "Private_Clean", "Private_Dirty", "SwapPss")


def ppid_map():
    m = {}
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                with open(f"/proc/{d}/stat") as f:
                    m[int(d)] = int(f.read().rsplit(")", 1)[1].split()[1])
            except OSError:
                pass
    return m


def rollup(pid):
    v = {}
    with open(f"/proc/{pid}/smaps_rollup") as f:
        for line in f:
            k, _, rest = line.partition(":")
            if k in FIELDS:
                v[k] = int(rest.split()[0])
    return v


def info(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().replace(b"\0", b" ").decode(errors="replace")
        with open(f"/proc/{pid}/environ", "rb") as f:
            env = dict(x.split(b"=", 1) for x in f.read().split(b"\0") if b"=" in x)
        rank = int(env.get(b"RANK", b"-1"))
    except OSError:
        cmd, rank = "", -1
    return cmd, rank


def avail_kb():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1])


def main():
    out, interval, min_avail = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]) * 2**20
    cmd = sys.argv[sys.argv.index("--") + 1:]
    p = subprocess.Popen(cmd, start_new_session=True)
    roles = {p.pid: ("launcher", -1)}
    aborted = False
    pool = ThreadPoolExecutor(max_workers=12)
    with open(out, "w") as f:
        while p.poll() is None:
            t = time.time()
            pm = ppid_map()
            kids = {}
            for c, pp in pm.items():
                kids.setdefault(pp, []).append(c)
            todo, desc = [p.pid], []
            while todo:
                x = todo.pop()
                desc.append(x)
                todo += kids.get(x, [])
            rows = []
            for pid in desc:
                if pid not in roles:
                    cmdl, rank = info(pid)
                    prole = roles.get(pm.get(pid), ("?", -1))[0]
                    if prole == "launcher":
                        role = "rank"
                    elif prole == "rank":
                        role = ("forkserver" if "multiprocessing.forkserver" in cmdl else
                                "tracker" if "resource_tracker" in cmdl else "worker")
                    elif prole == "forkserver":
                        role = "worker"
                    else:
                        role = "other"
                    roles[pid] = (role, rank)

            def one(pid):
                try:
                    return rollup(pid)
                except (OSError, ValueError):
                    return None

            for pid, v in zip(desc, pool.map(one, desc)):
                if not v:
                    continue
                role, rank = roles[pid]
                rows.append([pid, pm.get(pid), role, rank, v.get("Rss", 0), v.get("Pss", 0), v.get("Pss_Anon", 0),
                             v.get("Private_Clean", 0) + v.get("Private_Dirty", 0), v.get("SwapPss", 0)])
            av = avail_kb()
            f.write(json.dumps({"t": t, "dt": round(time.time() - t, 4), "avail_kb": av, "p": rows}) + "\n")
            f.flush()
            if av < min_avail and not aborted:
                os.killpg(p.pid, signal.SIGKILL)
                aborted = True
                f.write(json.dumps({"t": time.time(), "abort": "MemAvailable below limit"}) + "\n")
            time.sleep(max(0.0, interval - (time.time() - t)))
    sys.exit(p.returncode if not aborted else 99)


if __name__ == "__main__":
    main()
