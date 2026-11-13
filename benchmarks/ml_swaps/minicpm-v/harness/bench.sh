#!/bin/bash
# fresh process per run; orig and patched interleaved
set -e
B=$BENCH/minicpm-v
OUT=$B/harness/results.jsonl
: > $OUT
for w in 0 4; do
  for i in 1 2 3 4 5; do
    for arm in repo-orig repo; do
      /usr/bin/time -l $B/venv/bin/python $B/harness/run.py --repo $B/$arm --data $B/data/minicpm_665k.json --n 20000 --workers $w > $B/harness/last.out 2> $B/harness/last.err
      json=$(grep '^{' $B/harness/last.out)
      real=$(grep ' real ' $B/harness/last.err | awk '{print $1}')
      rss=$(grep 'maximum resident set size' $B/harness/last.err | awk '{print $1}')
      fp=$(grep 'peak memory footprint' $B/harness/last.err | awk '{print $1}')
      echo "{\"arm\":\"$arm\",\"workers\":$w,\"run\":$i,\"wall_s\":$real,\"max_rss\":$rss,\"peak_footprint\":$fp,\"r\":$json}" >> $OUT
    done
  done
done
echo done
