#!/bin/bash
# packmem 0.3.2 re-run: one rank, as in a single-GPU job. Records first (verify, pickle), then the main
# process alone (no workers, 20k samples), then one full shuffled epoch (665,298 samples) through 4 fork
# and 4 spawn workers. Arms interleaved per repetition. Each run waits up to 10 min for load <= 4.
export L=${L:-$HOME/pm032-bench} MEMMAX=40G SHARDS=1 MAXLOAD=4
H=$L/harness
log() { echo "$(date '+%F %T') $*" >> $L/out/seq_qwen032.log; }
mkdir -p $L/out
log "start $(cut -d' ' -f1-3 /proc/loadavg)"
bash $H/single.sh >> $L/out/seq_qwen032.log 2>&1
for r in 1 2 3; do
  log "$($H/run.sh q_main_list_r$r qwen 1 0 fork 20000 8)"
  log "$($H/run.sh q_main_pm_r$r qwen-pm 1 0 fork 20000 4)"
done
for ctx in fork spawn; do
  for r in 1 2 3; do
    log "$($H/run.sh q_epoch_${ctx}_list_r$r qwen 1 4 $ctx 0 20)"
    log "$($H/run.sh q_epoch_${ctx}_pm_r$r qwen-pm 1 4 $ctx 0 8)"
  done
done
log "end $(cut -d' ' -f1-3 /proc/loadavg)"
