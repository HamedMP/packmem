#!/bin/bash
# 0.1.2 gate, candidate 630df090 (d81ad22, background packing opt-in): list / PyPI 0.1.1 (e705bd7b) / candidate at its
# default, 5 interleaved fresh processes per arm, load <= 4 at start (max 10 min). Then PACKMEM_LOAD_THREADS=1 once,
# identical-output checks, the reclaimability probe, and last the mixed-path nbytes check. Serial throughout.
set -u
H="$(cd "$(dirname "$0")" && pwd)"; WK="$(dirname "$(dirname "$H")")"; LN=$WK/llava-next
A=$H/out/g3; V=$LN/harness/v3/verify_g3; mkdir -p $A $V
NFILES="$WK/data/llava_v1_5_mix665k.json $LN/data/llava_v1_5_mix665k.json $LN/data/si_mix.json $LN/data/text_mix.jsonl"
echo "seq_gate3 start $(date '+%F %T') $(uptime)" >> $H/load.log
shasum -a 256 $WK/wheel-cand/*.whl $WK/wheel-pypi/*.whl >> $H/load.log
"$H/run_all_v3.sh" build llava665k 5 g3_build orig repo@pypi repo
"$LN/harness/v3/runs.sh" g3 5 repo-orig repo@pypi repo
PACKMEM_LOAD_THREADS=1 "$H/run_all_v3.sh" build llava665k 1 g3_build_t1 repo
PACKMEM_LOAD_THREADS=1 "$LN/harness/v3/runs.sh" g3_t1 1 repo
echo "seq_gate3 timed_done $(date '+%F %T') $(uptime)" >> $H/load.log
# allocation breakdown right after the build, and whether a later ~600 MiB of allocations reuses freed memory
for cfg in "pypi:$WK/venv-pypi:" "cand:$WK/venv:" "cand_t1:$WK/venv:1"; do
  IFS=: read name venv thr <<< "$cfg"
  "$H/wait_load.sh" $H/load.log "g3/vm_qwen_$name"
  (cd $H && env ${thr:+PACKMEM_LOAD_THREADS=$thr} VMMAP=1 REUSE_MB=600 MIX_DATASETS=llava665k $venv/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/vm_qwen_$name.json > /dev/null 2>$A/vm_qwen_$name.err)
done
for cfg in "pypi:$LN/venv-pypi::repo" "cand:$LN/venv::repo" "cand_t1:$LN/venv:1:repo"; do
  IFS=: read name venv thr tree <<< "$cfg"
  "$H/wait_load.sh" $H/load.log "g3/vm_llava_$name"
  (cd $LN/harness/v3 && env ${thr:+PACKMEM_LOAD_THREADS=$thr} REUSE_MB=600 $venv/bin/python -I vmcheck.py $LN/$tree $LN/data/mix.yaml $A/vm_llava_$name.json > /dev/null 2>$A/vm_llava_$name.err)
done
echo "seq_gate3 vm_done $(date '+%F %T') $(uptime)" >> $H/load.log
# identical output, untimed
"$H/run_all_v3.sh" verify llava665k 1 g3_verify repo@pypi repo
"$H/run_all_v3.sh" build "llava665k%50,llava150k" 1 g3_buildmix orig repo@pypi repo
for arm in repo-orig repo@pypi repo; do
  tree="${arm%@*}"; py=$LN/venv/bin/python; [ "$tree" != "$arm" ] && py=$LN/venv-${arm#*@}/bin/python
  for d in mix.yaml mix_random.yaml; do
    (cd $LN/harness && $py -I bench.py $LN/$tree $LN/data/$d $V/check_${d%%.yaml}_$arm.json --hash > /dev/null 2>&1)
  done
done
(cd $H && $WK/venv-pypi/bin/python -I nestcheck.py $A/nest_pypi.json $NFILES > /dev/null)
(cd $H && $WK/venv/bin/python -I nestcheck.py $A/nest_cand.json $NFILES > /dev/null)
(cd $H && PACKMEM_LOAD_THREADS=1 $WK/venv/bin/python -I nestcheck.py $A/nest_cand_t1.json $NFILES > /dev/null)
echo "seq_gate3 checks_done $(date '+%F %T') $(uptime)" >> $H/load.log
# mixed-path nbytes, candidate default and PyPI 0.1.1
(cd $H && $WK/venv/bin/python -I mixcheck.py steps $WK/data $A/mixsteps_cand.json > /dev/null)
(cd $H && $WK/venv/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/mixrepo_cand.json > /dev/null 2>&1)
(cd $H && $WK/venv-pypi/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/mixrepo_pypi.json > /dev/null 2>&1)
echo "seq_gate3 end $(date '+%F %T') $(uptime)" >> $H/load.log
echo done
