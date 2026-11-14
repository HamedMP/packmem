#!/bin/bash
# Follow-up step 2 (build-time re-measure) and correctness checks, then the nbytes re-check. Serial throughout.
set -u
H="$(cd "$(dirname "$0")" && pwd)"; WK="$(dirname "$(dirname "$H")")"; LN=$WK/llava-next
OLD=$WK/wheel/packmem-0.1.1-cp310-abi3-macosx_11_0_arm64.whl        # f34d69df (share() runs)
NEW=$WK/wheel-new/packmem-0.1.1-cp310-abi3-macosx_11_0_arm64.whl    # db12cb13 (a78832a)
A=$H/out/addon; V=$LN/harness/v3/verify; mkdir -p $A $V
NFILES="$WK/data/llava_v1_5_mix665k.json $LN/data/llava_v1_5_mix665k.json $LN/data/si_mix.json $LN/data/text_mix.jsonl"
inst() { "$1/bin/pip" install -q --force-reinstall --no-deps "$2" 2>&1 | grep -v notice; "$1/bin/python" -I -c "import packmem; print('$1', packmem.__version__)" >> $H/load.log; }
echo "seq_build start $(date '+%F %T') $(uptime)" >> $H/load.log
shasum -a 256 $OLD $NEW >> $H/load.log
# reference: the share() wheel
inst $LN/venv $OLD
"$H/run_all_v3.sh" build llava665k 3 build_f34d repo
"$LN/harness/v3/runs.sh" f34d 3 repo
(cd $H && $WK/venv/bin/python -I nestcheck.py $A/nest_f34d.json $NFILES > /dev/null)
# the newest wheel
inst $WK/venv $NEW
inst $LN/venv $NEW
"$H/run_all_v3.sh" build llava665k 5 build_new orig repo
PACKMEM_LOAD_THREADS=0 "$H/run_all_v3.sh" build llava665k 1 build_new_t0 repo
"$LN/harness/v3/runs.sh" new 5 repo-orig repo
PACKMEM_LOAD_THREADS=0 "$LN/harness/v3/runs.sh" new_t0 1 repo
echo "seq_build timed_done $(date '+%F %T') $(uptime)" >> $H/load.log
# correctness, untimed
"$H/run_all_v3.sh" verify llava665k 1 verify_new repo
"$H/run_all_v3.sh" build "llava665k%50,llava150k" 1 buildmix_new orig repo
for arm in repo-orig repo; do
  for d in mix.yaml mix_random.yaml; do
    (cd $LN/harness && $LN/venv/bin/python -I bench.py $LN/$arm $LN/data/$d $V/check_${d%%.yaml}_$arm.json --hash > /dev/null 2>&1)
  done
done
(cd $H && $WK/venv/bin/python -I nestcheck.py $A/nest_new.json $NFILES > /dev/null)
(cd $H && PACKMEM_LOAD_THREADS=0 $WK/venv/bin/python -I nestcheck.py $A/nest_new_t0.json $NFILES > /dev/null)
echo "seq_build checks_done $(date '+%F %T') $(uptime)" >> $H/load.log
# nbytes re-check with the newest wheel
(cd $H && $WK/venv/bin/python -I mixcheck.py steps $WK/data $A/mixsteps_new.json > /dev/null)
(cd $H && $WK/venv/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/mixrepo_new.json > /dev/null 2>&1)
(cd $H && MIX_DATASETS=llava665k $WK/venv/bin/python -I mixcheck.py repo $WK/repo $WK/data $A/mixrepo_single_new.json > /dev/null 2>&1)
echo "seq_build end $(date '+%F %T') $(uptime)" >> $H/load.log
echo done
