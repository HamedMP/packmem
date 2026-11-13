#!/bin/bash
# Re-run after ~/packmem-bench was deleted externally at ~17:46: MiniCPM record digests, forkserver 2x4 x3.
L=$HOME/packmem-bench/linux-node
H=$L/harness
log() { echo "$(date '+%F %T') $*" >> $L/out/seq_mcpm_redo.log; }
mkdir -p $L/out/single
log "start $(cut -d' ' -f1-3 /proc/loadavg)"
for t in minicpm minicpm-pm; do
  TREE=$L/repos/$t DATA=$L/data/minicpm_665k.json systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- \
    nice -n 10 $L/venv-mcpm/bin/python -I $H/mcpm_single.py $L/out/single/${t}_verify > $L/out/single/${t}_verify.log 2>&1
  log "verify $t rc=$? $(grep '^{' $L/out/single/${t}_verify.log)"
done
cmp $L/out/single/minicpm_verify.digests $L/out/single/minicpm-pm_verify.digests && log "per-record digests identical" || log "per-record digests DIFFER"
for r in 1 2 3; do
  log "$($H/run_m.sh m_forkserver_pm_2x4_r$r minicpm-pm 2 4 forkserver 20000 8)"
  log "$($H/run_m.sh m_forkserver_list_2x4_r$r minicpm 2 4 forkserver 20000 36)"
done
log "end $(cut -d' ' -f1-3 /proc/loadavg)"
