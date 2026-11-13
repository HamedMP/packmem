#!/usr/bin/env bash
# run1.sh NAME EXPECTED_PEAK_GB SCRIPT ARGS...  -- one capped, niced, fresh process
set -u
ROOT=$HOME/packmem-hfbench
export HF_HOME=$ROOT/hf HF_DATASETS_CACHE=$ROOT/hf/datasets HF_HUB_DISABLE_TELEMETRY=1 HF_DATASETS_OFFLINE=1
name=$1; exp=$2; shift 2
mkdir -p "$ROOT/out"
avail=$(free -g | awk '/^Mem:/{print $7}')
if (( avail < exp + 30 )); then
  echo "{\"run\":\"$name\",\"skipped\":true,\"avail_gb\":$avail,\"expected_gb\":$exp}" | tee -a "$ROOT/out/runs.jsonl"
  exit 3
fi
l0=$(cut -d' ' -f1 /proc/loadavg)
t0=$(date +%s.%N)
nice -n 10 systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 \
  "$ROOT/venv/bin/python" -I "$ROOT/scripts/$@" > "$ROOT/out/$name.json" 2> "$ROOT/out/$name.err"
rc=$?
t1=$(date +%s.%N)
l1=$(cut -d' ' -f1 /proc/loadavg)
line="{\"run\":\"$name\",\"rc\":$rc,\"load_start\":$l0,\"load_end\":$l1,\"avail_gb\":$avail,\"wall_s\":$(echo "$t1 - $t0" | bc)}"
echo "$line" | tee -a "$ROOT/out/runs.jsonl"
exit $rc
