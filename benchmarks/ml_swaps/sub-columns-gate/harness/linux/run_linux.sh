#!/bin/bash
# usage: run_linux.sh KIND RUNS TAG ARM...    KIND = qwen-build | llava-build | qwen-verify
# One fresh process per run, arms interleaved (reversed on even runs), each in its own memory-capped scope:
#   systemd-run --user --scope -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 python -I ...
# No load gate (shared CI box): the 1/5/15-minute load is recorded at the start and end of every run.
# ARM = TREE (python from the base venv) or TREE@NAME (python from <base venv>-NAME). env passes through.
set -u
D=$HOME/packmem-subcol
KIND=$1; RUNS=$2; TAG=$3; shift 3; ARMS=("$@")
OUT=$D/out/$TAG; mkdir -p $OUT
echo "$TAG begin $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
for r in $(seq 1 "$RUNS"); do
  order=("${ARMS[@]}")
  if [ $((r % 2)) -eq 0 ]; then order=(); for ((i=${#ARMS[@]}-1; i>=0; i--)); do order+=("${ARMS[$i]}"); done; fi
  for arm in "${order[@]}"; do
    tree="${arm%@*}"; suffix=""; [ "$tree" != "$arm" ] && suffix="-${arm#*@}"
    case $KIND in
      qwen-build)  py=$D/venv$suffix/bin/python;  cmd=(-I $D/harness/v3/bench_v3.py $D/$tree build llava665k $OUT/${arm}_$r.json); cwd=$D/harness/v3 ;;
      qwen-verify) py=$D/venv$suffix/bin/python;  cmd=(-I $D/harness/v3/bench_v3.py $D/$tree verify llava665k $OUT/${arm}_$r.json); cwd=$D/harness/v3 ;;
      llava-build) py=$D/llava-next/venv$suffix/bin/python; cmd=(-I run_v2.py $D/llava-next/$tree $D/llava-next/data/mix.yaml --workers 0); cwd=$D/llava-next/harness/v2 ;;
    esac
    l0=$(cut -d' ' -f1-3 /proc/loadavg); t0=$(date +%s.%N)
    (cd $cwd && systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 "$py" "${cmd[@]}") > $OUT/${arm}_$r.out 2> $OUT/${arm}_$r.err
    rc=$?; t1=$(date +%s.%N); l1=$(cut -d' ' -f1-3 /proc/loadavg)
    echo "{\"tag\":\"$TAG\",\"arm\":\"$arm\",\"run\":$r,\"rc\":$rc,\"wall_s\":$(awk "BEGIN{print $t1 - $t0}"),\"load_start\":\"$l0\",\"load_end\":\"$l1\"}" > $OUT/${arm}_$r.meta
    [ "$KIND" = llava-build ] && grep '^{' $OUT/${arm}_$r.out > $OUT/${arm}_$r.json
  done
done
echo "$TAG end $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
