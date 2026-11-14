#!/usr/bin/env bash
# run2.sh VENV NAME EXPECTED_PEAK_GB SCRIPT ARGS...  -- run1.sh with a venv choice, out2/, and /dev/shm checks
set -u
ROOT=$HOME/packmem-hfbench
export HF_HOME=$ROOT/hf HF_DATASETS_CACHE=$ROOT/hf/datasets HF_HUB_DISABLE_TELEMETRY=1 HF_DATASETS_OFFLINE=1
export PMB_OUT=${PMB_OUT:-$ROOT/out2}
venv=$1; name=$2; exp=$3; shift 3
mkdir -p "$PMB_OUT"
avail=$(free -g | awk '/^Mem:/{print $7}')
if (( avail < exp + 30 )); then
  echo "{\"run\":\"$name\",\"skipped\":true,\"avail_gb\":$avail,\"expected_gb\":$exp}" | tee -a "$PMB_OUT/runs.jsonl"
  exit 3
fi
shm0=$(ls /dev/shm/packmem-*.pkm 2>/dev/null | wc -l)
l0=$(cut -d' ' -f1 /proc/loadavg)
t0=$(date +%s.%N)
nice -n 10 systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 \
  "$ROOT/$venv/bin/python" -I "$ROOT/scripts/$@" > "$PMB_OUT/$name.json" 2> "$PMB_OUT/$name.err"
rc=$?
t1=$(date +%s.%N)
l1=$(cut -d' ' -f1 /proc/loadavg)
shm1=$(ls /dev/shm/packmem-*.pkm 2>/dev/null | wc -l)
disk1=$(ls $ROOT/pkmshare/packmem-*.pkm 2>/dev/null | wc -l)
line="{\"run\":\"$name\",\"venv\":\"$venv\",\"rc\":$rc,\"load_start\":$l0,\"load_end\":$l1,\"avail_gb\":$avail,\"wall_s\":$(echo "$t1 - $t0" | bc),\"shm_pkm_before\":$shm0,\"shm_pkm_after\":$shm1,\"disk_share_pkm_after\":$disk1}"
echo "$line" | tee -a "$PMB_OUT/runs.jsonl"
exit $rc
