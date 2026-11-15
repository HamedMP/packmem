#!/bin/bash
# 4bf9c3e re-run of the 8-rank study, packmem arms only (list arms do not depend on packmem; compared with the 0.3.2 list runs).
export L=$HOME/packmem-bench8-4bf9c3e MEMMAX=40G SHARDS=8 MAXLOAD=4
H=$L/harness
log() { echo "$(date '+%F %T') $*" >> $L/out/seq_pm.log; }
log "start $(cut -d' ' -f1-3 /proc/loadavg)"
for r in 1 2 3; do log "$($H/run.sh q_fork_pm_8x4_r$r qwen-pm 8 4 fork 20000 10)"; done
log "$($H/run.sh q_shard_fork_pm_8x4 qwen-pm 8 4 fork 0 10)"
for r in 1 2 3; do log "$($H/run_m.sh m_fork_pm_8x4_r$r minicpm-pm 8 4 fork 20000 10)"; done
log "end $(cut -d' ' -f1-3 /proc/loadavg)"
echo SEQ_DONE >> $L/out/seq_pm.log
