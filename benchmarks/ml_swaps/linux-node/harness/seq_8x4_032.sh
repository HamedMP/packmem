#!/bin/bash
# packmem 0.3.2 re-run of the 8-rank study (RESULT.md): 8 torchrun ranks x 4 fork workers.
# Qwen 20k per rank x3, Qwen full 1/8 shard x1, MiniCPM 20k per rank x3; arms interleaved.
# Work dir L links repos, data and venvs from the 1-rank re-run. The list arm needs ~48-55 GiB,
# so these runs use a 64 GiB cap. EXP=50 makes run.sh wait until MemAvailable >= 80 GiB before a list run.
export L=${L:-$HOME/pm032-bench8} MEMMAX=64G SHARDS=8 MAXLOAD=4
H=$L/harness
log() { echo "$(date '+%F %T') $*" >> $L/out/seq_8x4_032.log; }
mkdir -p $L/out
log "start $(cut -d' ' -f1-3 /proc/loadavg)"
for r in 1 2 3; do
  log "$($H/run.sh q_fork_list_8x4_r$r qwen 8 4 fork 20000 50)"
  log "$($H/run.sh q_fork_pm_8x4_r$r qwen-pm 8 4 fork 20000 10)"
done
log "$($H/run.sh q_shard_fork_list_8x4 qwen 8 4 fork 0 50)"
log "$($H/run.sh q_shard_fork_pm_8x4 qwen-pm 8 4 fork 0 10)"
for r in 1 2 3; do
  log "$($H/run_m.sh m_fork_list_8x4_r$r minicpm 8 4 fork 20000 50)"
  log "$($H/run_m.sh m_fork_pm_8x4_r$r minicpm-pm 8 4 fork 20000 10)"
done
log "end $(cut -d' ' -f1-3 /proc/loadavg)"
