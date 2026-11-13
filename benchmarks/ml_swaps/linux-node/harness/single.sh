#!/bin/bash
# Single-process verify and pickle checks for both Qwen trees, capped and niced.
L=$HOME/packmem-bench/linux-node
mkdir -p $L/out/single
for t in qwen qwen-pm; do
  for m in verify pickle; do
    o=$L/out/single/${t}_$m; [ $m = pickle ] && o=$o.json
    echo "$t $m start $(cut -d' ' -f1-3 /proc/loadavg) avail $(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo) GB"
    TREE=$L/repos/$t DATA=$L/data systemd-run --user --scope -q -p MemoryMax=20G -p MemorySwapMax=0 -- \
      nice -n 10 $L/venv/bin/python -I $L/harness/qwen_single.py $m $o > $L/out/single/${t}_$m.log 2>&1
    echo "$t $m rc=$? end $(cut -d' ' -f1-3 /proc/loadavg)"; tail -1 $L/out/single/${t}_$m.log
  done
done
cmp $L/out/single/qwen_verify.digests $L/out/single/qwen-pm_verify.digests && echo "per-record digests identical"
