"""Summarise results/*.json as the README's results table: medians per variant and start method.

    python table.py            # print it
    python table.py --write    # replace the table between the markers in README.md
"""
import glob
import json
import os
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BEGIN, END = "<!-- results:begin -->", "<!-- results:end -->"


def label(r):
    pm = r["versions"].get("packmem", "")
    nxt = "" if pm.count(".") == 2 and "dev" not in pm else ", next release"
    return {
        "list": "List of dicts, `json.load`",
        "hf": "Hugging Face `datasets`, memory-mapped Arrow",
        "packmem": f"packmem `load_json(...).share()`{nxt}",
        "packmem-open": f"packmem `open()` of a saved table{nxt}",
        "floor": "Floor: no data, just Python, torch and the workers",
    }[r["mode"]] + f" ({pm})" * (r["mode"].startswith("packmem"))


def table():
    runs = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(HERE, "results", "*.json"))) if not p.endswith("prepare.json")]
    if not runs:
        sys.exit("no results yet: run bench.py")
    metric = runs[0]["charged_metric"]
    order = ["floor", "list", "hf", "packmem", "packmem-open"]
    med = statistics.median
    groups = {}
    for r in runs:
        groups.setdefault((r["start"], order.index(r["mode"]), r["versions"].get("packmem", ""), label(r)), []).append(r)
    mb = lambda v: f"{v / 1000:.1f} GB" if v >= 1000 else f"{v:.0f} MB"  # noqa: E731
    lines = [
        f"| Variant | Start | Runs | Peak memory, parent + {runs[0]['workers']} workers | Above the floor | Each worker, peak | Parent after building | Build | First batch | {runs[0]['samples']:,} samples |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    floor = {start: med(r["peak_sum"][metric] for r in rs) for (start, i, _, _), rs in groups.items() if order[i] == "floor"}
    for (start, _, _, name), rs in sorted(groups.items()):
        peak = med(r["peak_sum"][metric] for r in rs)
        above = "" if start not in floor or name.startswith("Floor") else f"+{mb(peak - floor[start])}"
        workers = [e[f"peak_{metric}"] for r in rs for e in r["per_process"] if e["role"] == "worker"]
        lines.append(
            f"| {name} | {start} | {len(rs)} | **{mb(peak)}** | {above} | {mb(min(workers))}–{mb(max(workers))} | "
            f"{mb(med(r['parent_after_build'][metric] for r in rs))} | {med(r['build_s'] for r in rs):.1f} s | "
            f"{med(r['first_batch_s'] for r in rs):.1f} s | {med(r['total_s'] for r in rs):.1f} s |"
        )
    ref = next(r for r in runs if r["mode"] != "floor")
    v = ref["versions"]
    m = ref["machine"]
    loads = [r["loadavg_at_start"] for r in runs]
    digests = {r["batch_digest"] for r in runs if r["mode"] != "floor"}
    what = "phys_footprint (macOS)" if metric == "footprint" else "PSS (Linux)"
    note = (
        f"{ref['file']} ({ref['records']:,} records, {ref['file_bytes'] / 1e6:.0f} MB). {m['platform']} {m['machine']}, "
        f"{m['cpus']} cores, {m['memory_gb']} GB; Python {v['python']}, torch {v.get('torch')}, datasets {v.get('datasets')}. "
        f"Memory is {what}, summed over the parent and its workers at each 0.25 s sample; medians of the runs shown. "
        f"Load average at the start of each run: {min(loads):.1f} to {max(loads):.1f}. "
        f"Batches identical across all {sum(r['mode'] != 'floor' for r in runs)} runs with data: {'yes' if len(digests) == 1 else 'NO'}."
    )
    prep = os.path.join(HERE, "results", "prepare.json")
    if os.path.exists(prep):
        p = {x["mode"]: x for x in json.load(open(prep))}
        built = lambda m, what: (f"{what} was already there from an earlier run" if p[m]["build_s"] < 0.05 else f"{what} took {p[m]['build_s']:.1f} s")
        once = [f"load_dataset took {p['hf']['build_s']:.1f} s (it reuses its Arrow cache when one exists)" if "hf" in p else "",
                built("packmem-open", "the saved .pkm") if "packmem-open" in p else ""]
        note += f" Built once before the runs: {', '.join(x for x in once if x)}."
    return "\n".join(lines) + "\n\n" + note


def main():
    t = table()
    if "--write" in sys.argv:
        p = os.path.join(HERE, "README.md")
        s = open(p).read()
        i, j = s.index(BEGIN) + len(BEGIN), s.index(END)
        open(p, "w").write(s[:i] + "\n" + t + "\n" + s[j:])
    print(t)


if __name__ == "__main__":
    main()
