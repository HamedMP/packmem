#!/bin/bash
# Re-run of the sub-column gate on main 7b5dd99: list / 0.2.0 / candidate PACKMEM_THREADS=1 (the gate) / candidate default threads (reported separately).
set -u
D=$HOME/packmem-subcol; H=$D/harness/linux; S=$D/out/subcol2; mkdir -p $S
scoped() { local label=$1 cwd=$2; shift 2; local l0=$(cut -d' ' -f1-3 /proc/loadavg) t0=$(date +%s.%N)
  (cd $cwd && systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 "$@")
  echo "$label rc=$? wall=$(awk "BEGIN{print $(date +%s.%N) - $t0}") load_start=$l0 load_end=$(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log; }
echo "seq_gate2 start $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
sha256sum $D/wheels/*/*.whl >> $D/load.log; cat $D/wheels/cand.commit >> $D/load.log 2>/dev/null
$D/venv-candt/bin/python -I -c "import os,packmem; print('candt PACKMEM_THREADS=', os.environ.get('PACKMEM_THREADS'), packmem.__version__)" >> $D/load.log
$H/run_linux.sh qwen-build 5 S2_build orig repo@020 repo@candt repo@cand
$H/run_linux.sh llava-build 5 S2_llava repo-orig repo@020 repo@candt repo@cand
for v in 020 candt cand; do
  scoped mem2_qwen_$v $D/harness/v3 env REUSE_MB=600 $D/venv-$v/bin/python -I $H/memcheck_linux.py qwen $D/repo $S/mem_qwen_$v.json > /dev/null
  scoped mem2_llava_$v $D/harness/v3 env REUSE_MB=600 $D/llava-next/venv-$v/bin/python -I $H/memcheck_linux.py llava $D/llava-next/repo $S/mem_llava_$v.json > /dev/null
done
for a in "020:$D/venv-020" "candt:$D/venv-candt" "cand:$D/venv-cand"; do IFS=: read tag venv <<< "$a"
  scoped subcol2_qwen_$tag $D/harness/v3 $venv/bin/python -I subcol.py qwen $D/data/llava_v1_5_mix665k.json $S $tag > $S/qwen_$tag.out 2> $S/qwen_$tag.err
done
echo "seq_gate2 end $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
