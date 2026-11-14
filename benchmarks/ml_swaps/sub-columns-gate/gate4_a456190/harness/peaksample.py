"""Run a command, sample its /proc status every 2 ms, and snapshot the largest file mappings when RssFile peaks.

usage: peaksample.py OUT.json -- CMD...
"""
import json, os, subprocess, sys, time

out = sys.argv[1]; cmd = sys.argv[sys.argv.index("--") + 1:]


def status(pid):
    d = {}
    with open(f"/proc/{pid}/status") as f:
        for line in f:
            k, _, v = line.partition(":")
            if k in ("VmRSS", "RssAnon", "RssFile", "RssShmem", "VmHWM"):
                d[k] = int(v.split()[0]) / 1024
    return d


def file_maps(pid, top=12):
    maps, cur = {}, None
    with open(f"/proc/{pid}/smaps") as f:
        for line in f:
            parts = line.split()
            if "-" in parts[0] and len(parts) >= 5 and ":" in parts[3]:
                cur = parts[5] if len(parts) >= 6 else "[anon]"
            elif parts[0] == "Rss:" and cur:
                maps[cur] = maps.get(cur, 0) + int(parts[1]) / 1024
    files = sorted(((k, round(v, 1)) for k, v in maps.items() if k.startswith("/")), key=lambda x: -x[1])
    anon = sorted(((k, round(v, 1)) for k, v in maps.items() if not k.startswith("/")), key=lambda x: -x[1])
    return {"files": files[:top], "non_file": anon[:6]}


p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
peak = {"VmRSS": 0, "RssAnon": 0, "RssFile": 0, "RssShmem": 0}
at_rss_peak = at_file_peak = None
last_hwm = 0
while p.poll() is None:
    try:
        s = status(p.pid)
        if s.get("VmRSS", 0) > peak["VmRSS"] + 2:
            at_rss_peak = {"status": s, **file_maps(p.pid)}
        if s.get("RssFile", 0) > peak["RssFile"] + 2:
            at_file_peak = {"status": s, **file_maps(p.pid)}
        for k in peak: peak[k] = max(peak[k], s.get(k, 0))
        last_hwm = s.get("VmHWM", last_hwm)
    except (FileNotFoundError, ProcessLookupError):
        break
    time.sleep(0.002)
json.dump({"cmd": cmd, "rc": p.wait(), "peak": peak, "VmHWM_last_seen": last_hwm,
           "at_rss_peak": at_rss_peak, "at_file_peak": at_file_peak}, open(out, "w"), indent=1)
