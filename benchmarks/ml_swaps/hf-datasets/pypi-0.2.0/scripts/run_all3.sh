#!/usr/bin/env bash
# v2b follow-up (wip/zero-copy-v2 @ 7de0b93, share() re-attaches the parent): only the v2 arms, in venv2b, into out3/.
set -u
ROOT=$HOME/packmem-hfbench
cd "$ROOT"
export PMB_OUT=$ROOT/out3
S=scripts/run2.sh
PY="$ROOT/venv2b/bin/python -I"
pc() { local op=$1 name=$2; shift 2; echo "{\"pcache\":\"$op\",\"before\":\"$name\",\"r\":$($PY scripts/pcache.py $op "$@")}" >> out3/runs.jsonl; }
echo "{\"phase\":\"prep\",\"t\":\"$(date -Iseconds)\"}" >> out3/runs.jsonl
$S venv2b prep_v2save 4 prep_v2save.py
$S venv2b hash_V2O 4 bench_load.py V2O hash
$S venv2b hash_V2S 4 bench_load.py V2S hash
echo "{\"phase\":\"dl\",\"t\":\"$(date -Iseconds)\"}" >> out3/runs.jsonl
for k in 1 2 3; do
  for st in fork forkserver; do
    $S venv2b dl_V2S_${st}_$k 6 bench_dl2.py V2S $st
    if [[ $st == forkserver ]]; then
      pc warm dl_V2O_${st}_$k pkm/mix665k.pkm
      $S venv2b dl_V2O_${st}_$k 4 bench_dl2.py V2O $st
    fi
    $S venv2b dl_E0v2_${st}_$k 4 bench_dl2.py E0 $st
  done
done
echo "{\"phase_done\":\"v2b\",\"t\":\"$(date -Iseconds)\"}" >> out3/runs.jsonl
touch out3/DONE_v2b
