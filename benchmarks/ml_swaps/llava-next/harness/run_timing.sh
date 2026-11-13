#!/bin/bash
# usage: run_timing.sh <orig|patched> <runs>
B=$BENCH/llava-next
v=$1; r=$B/repo; [ $v = orig ] && r=$B/repo-orig
for i in $(seq 1 $2); do
  /usr/bin/time -l $B/venv/bin/python $B/harness/bench.py $r $B/data/mix.yaml $B/runs/t_${v}_$i.json > /dev/null 2> $B/runs/t_${v}_$i.time
done
