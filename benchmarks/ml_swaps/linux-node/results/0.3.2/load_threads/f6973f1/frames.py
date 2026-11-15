import csv, subprocess, re, sys
csv.field_size_limit(10**9)
rows = [r for r in csv.DictReader(open(sys.argv[1])) if r["tid"] == sys.argv[2]]
for r in sorted(rows, key=lambda r: -int(r["size"]))[:3]:
    fs = [f.split(";") for f in r["stack_trace"].split("|") if f]
    names = subprocess.run(["rustfilt"], input="\n".join(f[0] for f in fs), capture_output=True, text=True).stdout.splitlines()
    print(f"--- {int(r['size'])/2**20:.1f} MiB x{r['num_allocations']}")
    for n, f in zip(names, fs):
        n = re.sub(r"::h[0-9a-f]{16}$", "", n)
        if "packmem" in n and not n.startswith(("<alloc", "alloc::", "core::", "std::")):
            for _ in range(3): n = re.sub(r"<[^<>]*>", "<>", n)
            loc = (f[1].split("/")[-1] + ":" + f[2]) if len(f) > 2 and f[2] != "0" else ""
            print("   ", n[:150], loc)
