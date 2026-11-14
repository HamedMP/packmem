#!/usr/bin/env bash
# Timed phase: 3 rounds of every load/access arm, then 3 rounds of the DataLoader runs. One process at a time.
set -u
ROOT=$HOME/packmem-hfbench
cd "$ROOT"
S=scripts/run1.sh
PY="$ROOT/venv/bin/python -I"
B1=$ROOT/hf/cache_B1
B3=$ROOT/hf/cache_B3
arrows() { find "$1" -name '*.arrow'; }
pc() { local op=$1 name=$2; shift 2; echo "{\"pcache\":\"$op\",\"before\":\"$name\",\"r\":$($PY scripts/pcache.py $op "$@")}" >> out/runs.jsonl; }

phase=${1:-all}

if [[ $phase == all || $phase == load ]]; then
  $S size_A 8 bench_load.py A size
  for k in 1 2 3; do
    pc warm full_A_$k data/llava_v1_5_mix665k.json;  $S full_A_$k 10 bench_load.py A full
    pc warm full_C_$k data/llava_v1_5_mix665k.json;  $S full_C_$k 4 bench_load.py C full
    pc warm full_B1warm_$k $(arrows $B1);          $S full_B1warm_$k 4 bench_load.py B1 full $B1
    pc drop full_B1cold_$k $(arrows $B1);          $S full_B1cold_$k 4 bench_load.py B1 full $B1
    pc warm full_B2_$k $(arrows $B1);              $S full_B2_$k 4 bench_load.py B2 full $B1
    pc warm full_B3_$k $(arrows $B3);              $S full_B3_$k 4 bench_load.py B3 full $B3
  done
fi

if [[ $phase == all || $phase == dl ]]; then
  for k in 1 2 3; do
    for st in fork forkserver; do
      exp=12; [[ $st == forkserver ]] && exp=28
      $S dl_A_${st}_$k $exp bench_dl.py A $st
      pc warm dl_B1_${st}_$k $(arrows $B1)
      $S dl_B1_${st}_$k 4 bench_dl.py B1 $st $B1
      $S dl_C_${st}_$k 6 bench_dl.py C $st
      $S dl_E_${st}_$k 4 bench_dl.py E $st
    done
  done
fi
