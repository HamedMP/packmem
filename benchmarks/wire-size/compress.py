"""Brotli sizes for every probe output and for the same records as one JSON array (the form an API sends).

usage: compress.py <probe.jsonl> <data dir> <bytes dir> > sizes.jsonl
Each output line is the probe line plus json_bytes, json_br11, json_br5, br11 and br5.
"""
import json, sys
from pathlib import Path

import brotli

probe, data, bdir = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
lines = {}
json_cache = {}


def json_of(ds, n):
    if (ds, n) not in json_cache:
        if ds not in lines:
            lines[ds] = [l for l in (data / f"{ds}.jsonl").read_text().split("\n") if l]
        # the records re-serialised the way JSON.stringify writes them (no spaces)
        b = ("[" + ",".join(lines[ds][:n]) + "]").encode()
        json_cache[(ds, n)] = (len(b), len(brotli.compress(b, quality=11)), len(brotli.compress(b, quality=5)))
    return json_cache[(ds, n)]


for line in open(probe):
    r = json.loads(line)
    b = (bdir / f"{r['dataset']}-{r['rows']}-{r['mode']}.pkm").read_bytes()
    assert len(b) == r["bytes"]
    # quality 11 runs at about 1 MB/s: at 100,000 rows only for the forms the conclusions rest on
    big = r["rows"] >= 100_000 and r["mode"] not in ("as_is", "all_but_fsst", "all") and "format" not in r  # released builds (measure_030.mjs) always get quality 11
    r["br11"] = None if big else len(brotli.compress(b, quality=11))
    r["br5"] = len(brotli.compress(b, quality=5))
    r["json_bytes"], r["json_br11"], r["json_br5"] = json_of(r["dataset"], r["rows"])
    print(json.dumps(r), flush=True)
