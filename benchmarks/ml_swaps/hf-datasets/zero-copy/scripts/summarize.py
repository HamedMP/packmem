"""summarize.py OUT_DIR: print the RESULT tables (medians of the 3 rounds) as Markdown."""
import glob
import json
import os
import statistics
import sys

OUT = sys.argv[1]
MB = 1e6


def load(name):
    p = f"{OUT}/{name}.json"
    if not os.path.exists(p) or os.path.getsize(p) == 0:
        return None
    return json.load(open(p))


def runs(prefix):
    return [d for d in (load(f"{prefix}_{k}") for k in (1, 2, 3)) if d]


def get(d, path):
    for k in path.split("."):
        d = d[k]
    return d


def med(ds, path, scale=1.0):
    vals = [get(d, path) for d in ds if d is not None]
    return statistics.median(vals) / scale if vals else None


def rng(ds, path, scale=1.0):
    vals = sorted(get(d, path) / scale for d in ds)
    return vals


def f(v, nd=2):
    if v is None:
        return "n/a"
    if isinstance(v, list):
        return " / ".join(f"{x:,.2f}" for x in v)
    if isinstance(v, float):
        return f"{v:,.{nd}f}"
    return f"{v:,}"


def table(head, rows):
    print("| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for r in rows:
        print("| " + " | ".join(str(c) for c in r) + " |")
    print()


ARMS = [("A", "full_A"), ("B1 warm", "full_B1warm"), ("B1 cold", "full_B1cold"), ("B2", "full_B2"),
        ("B3", "full_B3"), ("C", "full_C")]
R = {name: runs(p) for name, p in ARMS}

print("## Load / reload time (s, median of 3)\n")
rows = []
for name, _ in ARMS:
    ds = R[name]
    rows.append([name, f(med(ds, "load_s")), f(med(ds, "norm_s")), f(rng(ds, "load_s"))])
for name, p in (("B1 first conversion", "conv_B1"), ("B3 first conversion (from parquet)", "conv_B3")):
    ds = runs(p)
    rows.append([name, f(med(ds, "load_s")), "", f(rng(ds, "load_s"))])
table(["Arm", "load_s", "id normalize_s", "runs"], rows)

print("## Memory after load and after full pass (MB = 10^6 B, median of 3)\n")
keys = [("Rss", "Rss"), ("Pss", "Pss"), ("USS", "USS"), ("Private_Dirty", "Priv_Dirty"),
        ("Private_Clean", "Priv_Clean"), ("Shared_Clean", "Shared_Clean"), ("Pss_Anon", "Pss_Anon"),
        ("Pss_File", "Pss_File"), ("arrow_map.Rss", "arrow Rss"), ("arrow_map.Private", "arrow Private"),
        ("maxrss", "peak RSS")]
for when in ("mem_after_load", "mem_after_pass"):
    print(f"### {when}\n")
    rows = []
    for name, _ in ARMS:
        rows.append([name] + [f(med(R[name], f"{when}.{k}", MB), 0) for k, _ in keys])
    table(["Arm"] + [h for _, h in keys], rows)

print("## Access (s, median of 3)\n")
acc = [("rand100k_dict_s", "100k random x[i]"), ("rand20k_conv_s", "20k random x[i]['conversations']"),
       ("slice64_x2000_s", "2,000 random x[i:i+64]"), ("seq_pass_s", "full pass, conv[0]['value']"),
       ("lazy_rand100k_s", "packmem 100k rows_lazy(i,i+1)"), ("lazy_rand20k_conv_s", "packmem 20k lazy ['conversations']"),
       ("lazy_seq_pass_s", "packmem lazy() pass"), ("hf_iter_batch1000_pass_s", "HF ds.iter(1000) pass"),
       ("pickle_dumps_s", "pickle dumps"), ("pickle_loads_s", "pickle loads"), ("pickle_bytes", "pickle MB")]
rows = []
for key, label in acc:
    row = [label]
    for name, _ in ARMS:
        ds = R[name]
        if ds and key in ds[0]:
            row.append(f(med(ds, key, MB if key == "pickle_bytes" else 1.0), 1 if key == "pickle_bytes" else 3))
        else:
            row.append("")
    rows.append(row)
table(["Op"] + [n for n, _ in ARMS], rows)

print("## Per-op microseconds (median)\n")
rows = []
for key, n_ops, label in (("rand100k_dict_s", 100_000, "x[i] -> dict"), ("rand20k_conv_s", 20_000, "x[i]['conversations']"),
                          ("slice64_x2000_s", 128_000, "per row via x[i:i+64]"), ("seq_pass_s", 665_298, "per row, sequential")):
    rows.append([label] + [f(med(R[n], key) * 1e6 / n_ops, 2) if R[n] else "" for n, _ in ARMS])
table(["Op (us)"] + [n for n, _ in ARMS], rows)

print("## DataLoader (4 workers, batch 8, 20k random indices; MB, median of 3)\n")
rows = []
digests = set()
for st in ("fork", "forkserver"):
    for arm in ("A", "B1", "C", "E"):
        ds = runs(f"dl_{arm}_{st}")
        if not ds:
            continue
        if arm != "E":
            digests |= {d["batch_digest"] for d in ds}
        wk = [v for d in ds for v in d["per_process"].values() if v["role"] == "worker"]
        par = [v for d in ds for v in d["per_process"].values() if v["role"] == "parent"]
        wuss = sorted(v["peak_USS"] / MB for v in wk)
        wpd = sorted(v["peak_Private_Dirty"] / MB for v in wk)
        warrow = sorted(v.get("peak_arrow_rss", 0) / MB for v in wk)
        rows.append([
            arm, st,
            f(med(ds, "peak_pss_sum", MB), 0), f(med(ds, "peak_uss_sum", MB), 0), f(med(ds, "peak_pss_anon_sum", MB), 0),
            f(statistics.median(v["peak_USS"] / MB for v in par), 0),
            f"{wuss[0]:,.0f}-{wuss[-1]:,.0f}" if wuss else "",
            f"{wpd[0]:,.0f}-{wpd[-1]:,.0f}" if wpd else "",
            f"{warrow[0]:,.0f}-{warrow[-1]:,.0f}" if warrow else "",
            f(med(ds, "first_batch_s"), 2), f(med(ds, "epoch_s"), 2),
            f(med(ds, "pickled_dataset_bytes", MB), 3) if "pickled_dataset_bytes" in ds[0] else "",
            min(d["max_workers_seen"] for d in ds),
        ])
table(["Arm", "start", "peak PSS sum", "peak USS sum", "peak Pss_Anon sum", "parent peak USS",
       "worker peak USS", "worker peak Priv_Dirty", "worker peak arrow Rss", "first batch s", "20k epoch s",
       "pickled MB", "workers seen"], rows)
print(f"Distinct batch digests across A/B1/C DataLoader runs: {len(digests)} {sorted(digests)}\n")

print("## Loads\n")
for line in open(f"{OUT}/runs.jsonl"):
    d = json.loads(line)
    if "run" in d:
        print(f"- {d['run']}: rc={d.get('rc')} load {d.get('load_start')} -> {d.get('load_end')}, wall {d.get('wall_s', 0):.1f} s, avail {d.get('avail_gb')} GB")
