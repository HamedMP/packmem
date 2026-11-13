#!/bin/bash
# Re-run of the 4-worker configs and pickle timings (first pass overlapped other CPU-heavy work 15:47-16:06). 5 fresh processes per arm and config; orig and packmem interleaved; one config at a time.
B=$BENCH/minicpm-v
H=$B/harness/v2
OUT=$H/results_v2_rerun.jsonl
LOG=$H/load_rerun.log
: > $OUT
$BENCH/wait_load.sh $LOG
echo "start $(date '+%F %T') $(uptime)" >> $LOG
for cfg in 4:spawn 4:fork; do
  w=${cfg%%:*}; c=${cfg##*:}
  echo "cfg $cfg begin $(date '+%T') $(uptime | sed 's/.*load/load/')" >> $LOG
  for i in 1 2 3 4 5; do
    for arm in repo-orig repo; do
      (cd $H && /usr/bin/time -l $B/venv/bin/python run_v2.py --repo $B/$arm --data $B/data/minicpm_665k.json --n 20000 --workers $w --mp-context $c > $H/last.out 2> $H/last.err)
      json=$(grep '^{' $H/last.out)
      real=$(grep ' real ' $H/last.err | awk '{print $1}')
      rss=$(grep 'maximum resident set size' $H/last.err | awk '{print $1}')
      fp=$(grep 'peak memory footprint' $H/last.err | awk '{print $1}')
      echo "{\"arm\":\"$arm\",\"workers\":$w,\"ctx\":\"$c\",\"run\":$i,\"wall_s\":${real:-null},\"max_rss\":${rss:-null},\"peak_footprint\":${fp:-null},\"load1\":\"$(uptime | awk -F'averages: ' '{print $2}')\",\"r\":${json:-null}}" >> $OUT
    done
  done
  echo "cfg $cfg end $(date '+%T') $(uptime | sed 's/.*load/load/')" >> $LOG
done
for arm in repo-orig repo; do
  (cd $H && /usr/bin/time -l $B/venv/bin/python run_v2.py --repo $B/$arm --data $B/data/minicpm_665k.json --pickle > $H/pickle_rerun_$arm.out 2> $H/pickle_rerun_$arm.err)
done
echo "end $(date '+%F %T') $(uptime)" >> $LOG
echo done
