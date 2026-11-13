#!/bin/bash
# MiniCPM-V sequence. A 1-rank calibration of the list arm sets how many fork ranks fit under ~58 GiB.
L=$HOME/packmem-bench/linux-node
H=$L/harness
log() { echo "$(date '+%F %T') $*" >> $L/out/seq_mcpm.log; }
log "start $(cut -d' ' -f1-3 /proc/loadavg)"
log "$($H/run_m.sh m_cal_fork_list_1x4 minicpm 1 4 fork 20000 12)"
log "$($H/run_m.sh m_cal_fork_list_shard_1x4 minicpm 1 4 fork 0 14)"
fit() { $L/venv/bin/python -I -c "
import sys; sys.path.insert(0, '$H'); from summarize import summarize
p = summarize('$L/out/$1')['peak_pss_gib']; print(max(1, min(8, int(58 // (p + 0.2)))), round(p, 2))"; }
read R20 P20 < <(fit m_cal_fork_list_1x4)
read RSH PSH < <(fit m_cal_fork_list_shard_1x4)
log "calibration: per-rank list peak ${P20} GiB (20k) -> ${R20} ranks; ${PSH} GiB (shard) -> ${RSH} ranks"
for r in 1 2 3; do
  log "$($H/run_m.sh m_fork_list_${R20}x4_r$r minicpm $R20 4 fork 20000 $(python3 -c "print(int($R20*$P20)+2)"))"
  log "$($H/run_m.sh m_fork_pm_8x4_r$r minicpm-pm 8 4 fork 20000 10)"
  [ "$R20" != 8 ] && log "$($H/run_m.sh m_fork_pm_${R20}x4_r$r minicpm-pm $R20 4 fork 20000 10)"
done
for r in 1 2 3; do
  log "$($H/run_m.sh m_forkserver_pm_8x4_r$r minicpm-pm 8 4 forkserver 20000 28)"
  log "$($H/run_m.sh m_forkserver_pm_2x4_r$r minicpm-pm 2 4 forkserver 20000 8)"
  log "$($H/run_m.sh m_forkserver_list_2x4_r$r minicpm 2 4 forkserver 20000 36)"
done
log "$($H/run_m.sh m_spawn_pm_8x4_r1 minicpm-pm 8 4 spawn 20000 30)"
log "$($H/run_m.sh m_spawn_pm_2x4_r1 minicpm-pm 2 4 spawn 20000 8)"
log "$($H/run_m.sh m_spawn_list_2x4_r1 minicpm 2 4 spawn 20000 36)"
log "$($H/run_m.sh m_shard_fork_pm_8x4 minicpm-pm 8 4 fork 0 10)"
log "$($H/run_m.sh m_shard_fork_list_${RSH}x4 minicpm $RSH 4 fork 0 $(python3 -c "print(int($RSH*$PSH)+2)"))"
log "end $(cut -d' ' -f1-3 /proc/loadavg)"
