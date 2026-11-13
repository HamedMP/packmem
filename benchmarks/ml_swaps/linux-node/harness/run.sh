#!/bin/bash
# usage: run.sh TAG TREE NPROC WORKERS CTX N EXPECTED_PEAK_GB
# One torchrun job under a memory-capped, niced scope, sampled by monitor.py every 0.5 s.
set -u
L=$HOME/packmem-bench/linux-node
TAG=$1; TREE=$2; NPROC=$3; W=$4; CTX=$5; N=$6; EXP=$7
OUT=$L/out/$TAG
rm -rf "$OUT"; mkdir -p "$OUT/probe"
need=$((EXP + 30))
for i in $(seq 1 60); do
  avail=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo)
  [ "$avail" -ge "$need" ] && break
  echo "$(date +%T) $TAG waiting: available ${avail} GB < ${need} GB" >> $L/out/wait.log
  sleep 30
done
if [ "$avail" -lt "$need" ]; then echo "{\"skipped\": \"available $avail GB < $need GB\"}" > "$OUT/meta.json"; exit 3; fi
la0=$(cut -d' ' -f1-3 /proc/loadavg)
t0=$(date +%s.%N)
TREE=$L/repos/$TREE DATA=$L/data OUT_DIR=$OUT PROBE_DIR=$OUT/probe OMP_NUM_THREADS=1 \
  systemd-run --user --scope -q -p MemoryMax=70G -p MemorySwapMax=0 -- \
  nice -n 10 $L/venv/bin/python -I $L/harness/monitor.py "$OUT/monitor.jsonl" 0.5 25 -- \
  $L/venv/bin/torchrun --standalone --nproc_per_node=$NPROC \
  $L/harness/qwen_rank.py --samples $N --workers $W --ctx $CTX > "$OUT/stdout.log" 2> "$OUT/stderr.log"
rc=$?
t1=$(date +%s.%N)
la1=$(cut -d' ' -f1-3 /proc/loadavg)
cat > "$OUT/meta.json" <<J
{"tag": "$TAG", "tree": "$TREE", "nproc": $NPROC, "workers": $W, "ctx": "$CTX", "n": $N, "rc": $rc,
 "wall_s": $(echo "$t1 - $t0" | bc), "load_start": "$la0", "load_end": "$la1", "avail_gb_start": $avail}
J
echo "$TAG rc=$rc wall=$(echo "$t1 - $t0" | bc) load $la0 -> $la1"
