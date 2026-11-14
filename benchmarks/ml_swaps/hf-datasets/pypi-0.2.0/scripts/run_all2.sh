#!/usr/bin/env bash
# DataLoader rerun with the v2 arms: 3 rounds of {fork, forkserver} x arms. One process at a time.
# venv = PyPI packmem 0.1.1 (A, B1, C, E); venv2 = packmem v2 wip build (V2S, V2D, V2O, E2 floor).
set -u
ROOT=$HOME/packmem-hfbench
cd "$ROOT"
S=scripts/run2.sh
PY="$ROOT/venv/bin/python -I"
B1=$ROOT/hf/cache_B1
arrows() { find "$1" -name '*.arrow'; }
pc() { local op=$1 name=$2; shift 2; echo "{\"pcache\":\"$op\",\"before\":\"$name\",\"r\":$($PY scripts/pcache.py $op "$@")}" >> out2/runs.jsonl; }
phase=${1:-dl}
mkdir -p pkmshare
if [[ $phase == dl ]]; then
  echo "{\"phase\":\"dl\",\"t\":\"$(date -Iseconds)\"}" >> out2/runs.jsonl
  for k in 1 2 3; do
    for st in fork forkserver; do
      exp=12; [[ $st == forkserver ]] && exp=28
      $S venv dl_A_${st}_$k $exp bench_dl2.py A $st
      pc warm dl_B1_${st}_$k $(arrows $B1)
      $S venv dl_B1_${st}_$k 4 bench_dl2.py B1 $st $B1
      $S venv dl_C_${st}_$k 6 bench_dl2.py C $st
      $S venv dl_E_${st}_$k 4 bench_dl2.py E $st
      $S venv2 dl_V2S_${st}_$k 6 bench_dl2.py V2S $st
      $S venv2 dl_V2D_${st}_$k 6 bench_dl2.py V2D $st
      pc warm dl_V2O_${st}_$k pkm/mix665k.pkm
      $S venv2 dl_V2O_${st}_$k 4 bench_dl2.py V2O $st
      $S venv2 dl_E2_${st}_$k 4 bench_dl2.py E $st
    done
  done
fi
if [[ $phase == floor0 ]]; then
  echo "{\"phase\":\"floor0\",\"t\":\"$(date -Iseconds)\"}" >> out2/runs.jsonl
  for k in 1 2 3; do
    for st in fork forkserver; do
      $S venv dl_E0_${st}_$k 4 bench_dl2.py E0 $st
      $S venv2 dl_E0v2_${st}_$k 4 bench_dl2.py E0 $st
    done
  done
fi
if [[ $phase == access ]]; then
  echo "{\"phase\":\"access\",\"t\":\"$(date -Iseconds)\"}" >> out2/runs.jsonl
  for k in 1 2 3; do
    pc warm full_B1warm_$k $(arrows $B1);   $S venv full_B1warm_$k 4 bench_load.py B1 full $B1
    pc warm full_C_$k data/llava_v1_5_mix665k.json; $S venv full_C_$k 4 bench_load.py C full
    pc warm full_V2O_$k pkm/mix665k.pkm;    $S venv2 full_V2O_$k 4 bench_load.py V2O full
  done
fi
echo "{\"phase_done\":\"$phase\",\"t\":\"$(date -Iseconds)\"}" >> out2/runs.jsonl
touch out2/DONE_$phase
