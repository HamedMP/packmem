#!/bin/bash
# Coordinator follow-ups after sequence_gate.sh: THREADS=0 at 5 runs (Qwen, LLaVA-NeXT), and allocation
# breakdown (malloc in-use, footprint, vmmap -summary) right after the build for 0.1.1 / candidate / THREADS=0.
set -u
H="$(cd "$(dirname "$0")" && pwd)"; WK="$(dirname "$(dirname "$H")")"; LN=$WK/llava-next
until grep -q "seq_gate end" $H/load.log; do sleep 10; done
A=$H/out/addon/vm; mkdir -p $A
echo "seq_gate2 start $(date '+%F %T') $(uptime)" >> $H/load.log
PACKMEM_LOAD_THREADS=0 "$H/run_all_v3.sh" build llava665k 5 gate_build_t0x5 repo
PACKMEM_LOAD_THREADS=0 "$LN/harness/v3/runs.sh" gate_t0x5 5 repo
echo "seq_gate2 timed_done $(date '+%F %T') $(uptime)" >> $H/load.log
for cfg in "pypi:$WK/venv-pypi:" "cand:$WK/venv:" "cand_t0:$WK/venv:0"; do
  IFS=: read name venv thr <<< "$cfg"
  "$H/wait_load.sh" $H/load.log "vm/qwen_$name"
  (cd $H && env ${thr:+PACKMEM_LOAD_THREADS=$thr} VMMAP=1 MIX_DATASETS=llava665k $venv/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/qwen_$name.json > /dev/null 2>&1)
done
for cfg in "orig:$LN/venv::repo-orig" "pypi:$LN/venv-pypi::repo" "cand:$LN/venv::repo" "cand_t0:$LN/venv:0:repo"; do
  IFS=: read name venv thr tree <<< "$cfg"
  "$H/wait_load.sh" $H/load.log "vm/llava_$name"
  (cd $LN/harness/v3 && env ${thr:+PACKMEM_LOAD_THREADS=$thr} $venv/bin/python -I vmcheck.py $LN/$tree $LN/data/mix.yaml $A/llava_$name.json > /dev/null 2>&1)
done
echo "seq_gate2 end $(date '+%F %T') $(uptime)" >> $H/load.log
echo done
