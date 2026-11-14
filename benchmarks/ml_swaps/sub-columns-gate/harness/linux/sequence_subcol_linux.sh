#!/bin/bash
# Sub-column gate on the Linux server: list (venv) / 0.2.0 (venv-020) / candidate e4508b1 (venv-cand).
# Serial; every process in its own scope (MemoryMax=40G, no swap), nice 10; load recorded at start and end.
set -u
D=$HOME/packmem-subcol; H=$D/harness/linux; S=$D/out/subcol; mkdir -p $S $D/out/verify_llava
scoped() {  # scoped LABEL CWD CMD...
  local label=$1 cwd=$2; shift 2
  local l0=$(cut -d' ' -f1-3 /proc/loadavg) t0=$(date +%s.%N)
  (cd $cwd && systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 "$@")
  echo "$label rc=$? wall=$(awk "BEGIN{print $(date +%s.%N) - $t0}") load_start=$l0 load_end=$(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
}
echo "seq_subcol start $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg) nproc=$(nproc)" >> $D/load.log
sha256sum $D/wheels/*/*.whl >> $D/load.log
$H/run_linux.sh qwen-build 5 S_build orig repo@020 repo@cand
$H/run_linux.sh llava-build 5 S_llava repo-orig repo@020 repo@cand
for v in 020 cand; do
  scoped mem_qwen_$v $D/harness/v3 env REUSE_MB=600 $D/venv-$v/bin/python -I $H/memcheck_linux.py qwen $D/repo $S/mem_qwen_$v.json > /dev/null
  scoped mem_llava_$v $D/harness/v3 env REUSE_MB=600 $D/llava-next/venv-$v/bin/python -I $H/memcheck_linux.py llava $D/llava-next/repo $S/mem_llava_$v.json > /dev/null
done
for a in "list:$D/venv" "020:$D/venv-020" "cand:$D/venv-cand"; do
  IFS=: read tag venv <<< "$a"
  scoped subcol_qwen_$tag $D/harness/v3 $venv/bin/python -I subcol.py qwen $D/data/llava_v1_5_mix665k.json $S $tag > $S/qwen_$tag.out 2> $S/qwen_$tag.err
done
for v in 020 cand; do
  scoped subcol_files_$v $D/harness/v3 $D/venv-$v/bin/python -I subcol.py files $S $v $D/llava-next/data/llava_v1_5_mix665k.json $D/llava-next/data/si_mix.json $D/llava-next/data/text_mix.jsonl > $S/files_$v.out 2> $S/files_$v.err
done
$H/run_linux.sh qwen-verify 1 S_verify orig repo@020 repo@cand
for arm in repo-orig repo@020 repo@cand; do
  tree="${arm%@*}"; sfx=""; [ "$tree" != "$arm" ] && sfx="-${arm#*@}"
  for d in mix.yaml mix_random.yaml; do
    scoped hash_llava_${arm}_$d $D/llava-next/harness $D/llava-next/venv$sfx/bin/python -I bench.py $D/llava-next/$tree $D/llava-next/data/$d $D/out/verify_llava/check_${d%%.yaml}_$arm.json --hash > /dev/null 2>&1
  done
done
echo "seq_subcol end $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
