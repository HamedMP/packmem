import json, statistics as st
import glob; fs = sorted(glob.glob("exp-*.jsonl"))
for f in fs:
    r = [json.loads(l) for l in open(f)]
    m = lambda g: st.median(g(x) for x in r)
    print(f"{f:22s} n={len(r)} load_s {m(lambda x: x['load_s']):.2f} anon {m(lambda x: x['peak_mib']['RssAnon']):.0f} file {m(lambda x: x['peak_mib']['RssFile']):.0f} vmrss {m(lambda x: x['peak_mib']['VmRSS']):.0f} after {m(lambda x: x['after_mib']['RssAnon']):.0f} nbytes {set(x['nbytes'] for x in r)} load {r[0]['load_start'][0]}-{r[-1]['load_end'][0]}")
