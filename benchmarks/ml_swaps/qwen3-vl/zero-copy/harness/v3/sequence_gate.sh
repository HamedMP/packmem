#!/bin/bash
# 0.1.2 gate: list / packmem 0.1.1 from PyPI / candidate, 5 interleaved fresh processes per arm, then the candidate
# with PACKMEM_LOAD_THREADS=0, identical-output checks, and last the mixed-path nbytes re-check. Serial throughout.
# venv = candidate 75dbc431; venv-pypi = PyPI 0.1.1 e705bd7b (thin venv, torch etc. via .pth from venv).
set -u
H="$(cd "$(dirname "$0")" && pwd)"; WK="$(dirname "$(dirname "$H")")"; LN=$WK/llava-next
A=$H/out/addon; V=$LN/harness/v3/verify; mkdir -p $A $V
NFILES="$WK/data/llava_v1_5_mix665k.json $LN/data/llava_v1_5_mix665k.json $LN/data/si_mix.json $LN/data/text_mix.jsonl"
echo "seq_gate start $(date '+%F %T') $(uptime)" >> $H/load.log
shasum -a 256 $WK/wheel-new/*.whl $WK/wheel-pypi/*.whl >> $H/load.log
"$H/run_all_v3.sh" build llava665k 5 gate_build orig repo@pypi repo
PACKMEM_LOAD_THREADS=0 "$H/run_all_v3.sh" build llava665k 1 gate_build_t0 repo
"$LN/harness/v3/runs.sh" gate 5 repo-orig repo@pypi repo
PACKMEM_LOAD_THREADS=0 "$LN/harness/v3/runs.sh" gate_t0 1 repo
echo "seq_gate timed_done $(date '+%F %T') $(uptime)" >> $H/load.log
# identical output, untimed
"$H/run_all_v3.sh" verify llava665k 1 gate_verify repo@pypi repo
"$H/run_all_v3.sh" build "llava665k%50,llava150k" 1 gate_buildmix orig repo@pypi repo
for arm in repo-orig repo@pypi repo; do
  tree="${arm%@*}"; py=$LN/venv/bin/python; [ "$tree" != "$arm" ] && py=$LN/venv-${arm#*@}/bin/python
  for d in mix.yaml mix_random.yaml; do
    (cd $LN/harness && $py -I bench.py $LN/$tree $LN/data/$d $V/check_${d%%.yaml}_$arm.json --hash > /dev/null 2>&1)
  done
done
(cd $H && $WK/venv-pypi/bin/python -I nestcheck.py $A/nest_pypi.json $NFILES > /dev/null)
(cd $H && $WK/venv/bin/python -I nestcheck.py $A/nest_new.json $NFILES > /dev/null)
(cd $H && PACKMEM_LOAD_THREADS=0 $WK/venv/bin/python -I nestcheck.py $A/nest_new_t0.json $NFILES > /dev/null)
echo "seq_gate checks_done $(date '+%F %T') $(uptime)" >> $H/load.log
# mixed-path nbytes with the candidate
(cd $H && $WK/venv/bin/python -I mixcheck.py steps $WK/data $A/mixsteps_new.json > /dev/null)
(cd $H && $WK/venv/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/mixrepo_new.json > /dev/null 2>&1)
(cd $H && MIX_DATASETS=llava665k $WK/venv/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/mixrepo_single_new.json > /dev/null 2>&1)
echo "seq_gate end $(date '+%F %T') $(uptime)" >> $H/load.log
echo done
