"""summarize2.py OUT_DIR: DataLoader tables for the v2 rerun (medians of 3) as Markdown."""
import json
import os
import statistics
import sys

OUT = sys.argv[1]
MB = 1e6
ARMS = [("A", "list", "E"), ("B1", "HF Arrow mmap", "E"), ("C", "packmem 0.1.1 (pickle)", "E"),
        ("V2S", "v2 share() /dev/shm", "E2"), ("V2D", "v2 share(dir=disk)", "E2"), ("V2O", "v2 open(saved)", "E2"),
        ("E", "floor (venv 0.1.1)", None), ("E2", "floor (venv v2)", None),
        ("E0", "floor, no datasets/pyarrow (venv 0.1.1)", None), ("E0v2", "floor, no datasets/pyarrow (venv v2)", None)]
MATCHED = {"A": "E0", "B1": "E", "C": "E0", "V2S": "E0v2", "V2D": "E0v2", "V2O": "E0v2"}


def load(name):
    p = f"{OUT}/{name}.json"
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return None
    return json.load(open(p))


def runs(prefix):
    return [d for d in (load(f"{prefix}_{k}") for k in (1, 2, 3)) if d]


def med(ds, key, scale=MB):
    v = [d[key] for d in ds if key in d]
    return statistics.median(v) / scale if v else None


def rng(vals, nd=0):
    if not vals:
        return ""
    vals = sorted(vals)
    a, b = vals[0], vals[-1]
    return f"{a:,.{nd}f}" if round(a, nd) == round(b, nd) else f"{a:,.{nd}f}-{b:,.{nd}f}"


def f(v, nd=0):
    return "" if v is None else f"{v:,.{nd}f}"


def workers(d):
    return {pid: v for pid, v in d["per_process"].items() if v["role"] == "worker"}


def table(head, rows):
    print("| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for r in rows:
        print("| " + " | ".join(str(c) for c in r) + " |")
    print()


R = {(a, st): runs(f"dl_{a}_{st}") for a, _, _ in ARMS for st in ("fork", "forkserver")}
digests = {}
for st in ("fork", "forkserver"):
    print(f"### {st}\n")
    rows, rows2, rows3 = [], [], []
    for a, label, floor in ARMS:
        ds = R[(a, st)]
        if not ds:
            continue
        if not a.startswith("E"):
            for d in ds:
                digests.setdefault(d["batch_digest"], []).append(f"{a}/{st}")
        anon = med(ds, "peak_pss_anon_sum")
        fl = med(R[(floor, st)], "peak_pss_anon_sum") if floor and R[(floor, st)] else None
        above = f"{anon - fl:+,.0f}" if fl is not None else ""
        mf = MATCHED.get(a)
        mfl = med(R[(mf, st)], "peak_pss_anon_sum") if mf and R.get((mf, st)) else None
        above_m = f"{anon - mfl:+,.0f} ({mf})" if mfl is not None else ""
        par = [v["peak_USS"] / MB for d in ds for v in d["per_process"].values() if v["role"] == "parent"]
        wk = [v for d in ds for v in workers(d).values()]
        tot = med(ds, "peak_total_incl_tmpfs")
        pss = med(ds, "peak_pss_sum")
        rows.append([a, label, f(pss), f(tot) if tot and abs(tot - pss) > 0.5 else "same", f(anon), above, above_m,
                     f(med(ds, "peak_pss_shmem_sum")), f(statistics.median(par)),
                     f(med(ds, "first_batch_s", 1), 2), f(med(ds, "epoch_s", 1), 2),
                     (f"{med(ds, 'pickled_dataset_bytes', 1):,.0f} B" if med(ds, 'pickled_dataset_bytes', 1) < 1e5
                      else f"{med(ds, 'pickled_dataset_bytes'):,.1f} MB") if "pickled_dataset_bytes" in ds[0] else "",
                     min(d["max_workers_seen"] for d in ds)])
        rows2.append([a, rng([v["peak_USS"] / MB for v in wk]), rng([v["peak_Pss"] / MB for v in wk]),
                      rng([v["peak_Private_Dirty"] / MB for v in wk]), rng([v["peak_Pss_Anon"] / MB for v in wk])])
        # coherent end-of-epoch snapshot of the file mappings, per worker
        for tag, key in (("pkm", "end_of_epoch_pkm"), ("arrow", "end_of_epoch_arrow")):
            ends = [d[key][pid] for d in ds for pid in workers(d) if pid in d.get(key, {})]
            ends = [e for e in ends if e["paths"]]
            if ends:
                rows3.append([a, tag, rng([e["Rss"] / MB for e in ends]), rng([e["Shared_Clean"] / MB for e in ends]),
                              rng([e["Private_Clean"] / MB for e in ends]), rng([e["Shared_Dirty"] / MB for e in ends]),
                              rng([e["Private_Dirty"] / MB for e in ends]),
                              rng([e["Pss"] / MB for e in ends]),
                              rng([v.get(f"peak_{'pkm' if tag == 'pkm' else 'arrowmap'}_Rss", 0) / MB for v in wk])])
    table(["Arm", "", "node peak PSS sum", "node peak incl. whole tmpfs file", "node peak Pss_Anon sum",
           "anon above E floor", "anon above import-matched floor", "node peak Pss_Shmem", "parent peak USS", "first batch s", "20k epoch s",
           "pickled to each worker", "workers seen"], rows)
    table(["Arm", "worker peak USS", "worker peak PSS", "worker peak Private_Dirty", "worker peak Pss_Anon"], rows2)
    if rows3:
        table(["Arm", "file", "worker map Rss (end)", "Shared_Clean", "Private_Clean", "Shared_Dirty", "Private_Dirty", "map Pss",
               "worker map peak Rss"], rows3)

print("### Per-row access, one process (s, median of 3; us/op in parentheses)\n")
ACC = [("B1", "full_B1warm"), ("C", "full_C"), ("V2O", "full_V2O")]
A2 = {a: runs(p) for a, p in ACC}
rows = []
for key, n, label in (("rand100k_dict_s", 100_000, "100k random x[i] -> dict"), ("rand20k_conv_s", 20_000, "20k random x[i]['conversations']"),
                      ("slice64_x2000_s", 128_000, "2,000 random x[i:i+64] (per row)"), ("seq_pass_s", 665_298, "full pass (per row)")):
    rows.append([label] + [f"{med(A2[a], key, 1):.3f} ({med(A2[a], key, 1) * 1e6 / n:.2f})" if A2[a] else "" for a, _ in ACC])
rows.append(["pickle bytes"] + [f"{med(A2[a], 'pickle_bytes', 1):,.0f}" if A2[a] else "" for a, _ in ACC])
for k in ("Pss_Anon", "USS", "Rss"):
    rows.append([f"mem after pass {k} MB"] + [f(med([d["mem_after_pass"] for d in A2[a]], k)) if A2[a] else "" for a, _ in ACC])
table(["Op"] + [a for a, _ in ACC], rows)
if A2["B1"] and A2["C"]:
    for a in ("C", "V2O"):
        if A2[a]:
            print(f"- HF/{a} random row to dict: {med(A2['B1'], 'rand100k_dict_s', 1) / med(A2[a], 'rand100k_dict_s', 1):.2f}x; "
                  f"['conversations']: {med(A2['B1'], 'rand20k_conv_s', 1) / med(A2[a], 'rand20k_conv_s', 1):.2f}x; "
                  f"full pass: {med(A2['B1'], 'seq_pass_s', 1) / med(A2[a], 'seq_pass_s', 1):.2f}x")
    print()

print("### Shared / saved files\n")
for (a, st), ds in R.items():
    if ds and "file" in ds[0].get("extra", {}):
        fi = [d["extra"]["file"] for d in ds]
        print(f"- {a}/{st}: {fi[0]['fs']} {os.path.dirname(fi[0]['path'])}/, size {fi[0]['size']:,} B, mode {fi[0]['mode']}"
              f", share_s {f(med(ds, 'extra', 1) if False else statistics.median(d['extra'].get('share_s', d['extra'].get('open_s', 0)) for d in ds), 3)}"
              f", exists at end of run (before exit): {[d.get('file_exists_at_end') for d in ds]}")
print()
print(f"Distinct batch digests across data arms: {len(digests)}")
for k, v in digests.items():
    print(f"- {k}: {len(v)} runs ({', '.join(sorted(set(v)))})")
print("\n### Loads\n")
for line in open(f"{OUT}/runs.jsonl"):
    d = json.loads(line)
    if "run" in d:
        print(f"- {d['run']} [{d.get('venv')}]: rc={d.get('rc')} load {d.get('load_start')} -> {d.get('load_end')}, "
              f"wall {d.get('wall_s', 0):.1f} s, avail {d.get('avail_gb')} GB, /dev/shm pkm {d.get('shm_pkm_before')}->{d.get('shm_pkm_after')}")
    elif "phase" in d:
        print(f"- phase `{d['phase']}` started {d['t']}")
