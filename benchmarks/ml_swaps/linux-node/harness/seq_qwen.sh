#!/bin/bash
# Qwen sequence. Arms interleaved per repetition. Expected peaks (GiB) come from the 1-rank calibration runs.
H=$HOME/packmem-bench/linux-node/harness
log() { echo "$(date '+%F %T') $*" >> $HOME/packmem-bench/linux-node/out/seq_qwen.log; }
log "start $(cut -d' ' -f1-3 /proc/loadavg)"
for r in 1 2 3; do
  log "$($H/run.sh q_fork_list_8x4_r$r qwen 8 4 fork 20000 52)"
  log "$($H/run.sh q_fork_pm_8x4_r$r qwen-pm 8 4 fork 20000 8)"
done
for ctx in forkserver spawn; do
  for r in 1 2 3; do
    log "$($H/run.sh q_${ctx}_pm_8x4_r$r qwen-pm 8 4 $ctx 20000 25)"
    log "$($H/run.sh q_${ctx}_pm_2x4_r$r qwen-pm 2 4 $ctx 20000 8)"
    log "$($H/run.sh q_${ctx}_list_2x4_r$r qwen 2 4 $ctx 20000 34)"
  done
done
log "$($H/run.sh q_shard_fork_pm_8x4 qwen-pm 8 4 fork 0 10)"
log "$($H/run.sh q_shard_forkserver_pm_8x4 qwen-pm 8 4 forkserver 0 25)"
log "$($H/run.sh q_shard_forkserver_list_2x4 qwen 2 4 forkserver 0 34)"
log "$($H/run.sh q_shard_fork_list_8x4 qwen 8 4 fork 0 58)"
log "end $(cut -d' ' -f1-3 /proc/loadavg)"
