import csv, sys, collections, re, subprocess
csv.field_size_limit(10**9)
MB = 1024*1024
def own(f):
    return re.match(r"^(<)?(_?packmem::|<_?packmem::)", f) is not None
def short(s):
    s = re.sub(r"::h[0-9a-f]{16}$", "", s)
    for _ in range(4): s = re.sub(r"<[^<>]*>", "<>", s)
    return s
for path in sys.argv[1:]:
    rows = list(csv.DictReader(open(path)))
    raw = [[f.split(";")[0] for f in r["stack_trace"].split("|") if f] for r in rows]
    uniq = sorted({f for fs in raw for f in fs})
    out = subprocess.run(["rustfilt"], input="\n".join(uniq), capture_output=True, text=True).stdout.splitlines()
    d = dict(zip(uniq, out))
    agg = collections.Counter(); thr = collections.defaultdict(collections.Counter)
    for r, fs in zip(rows, raw):
        ds = [short(d[f]) for f in fs]
        mine = [f for f in ds if own(f)]
        key = " <- ".join(mine[:3]) if mine else "(outside packmem) " + (ds[0] if ds else "?")
        if r["allocator"] == "MMAP": key = "[mmap] " + key
        agg[key] += int(r["size"]); thr[r["tid"]][key] += int(r["size"])
    print(f"== {path}: {sum(agg.values())/MB:.1f} MiB live at the high-water mark")
    for k, v in agg.most_common(25): print(f"{v/MB:8.1f}  {k[:240]}")
    print("per thread:")
    for t, c in sorted(thr.items(), key=lambda x: -sum(x[1].values())):
        print(f"  tid {t}: {sum(c.values())/MB:.1f} MiB")
        for k, v in c.most_common(4): print(f"      {v/MB:8.1f}  {k[:200]}")
    print()
