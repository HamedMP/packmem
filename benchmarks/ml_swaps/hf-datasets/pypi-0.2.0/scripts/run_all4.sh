#!/usr/bin/env bash
# PyPI packmem 0.2.0 three-way: list vs HF Arrow vs packmem share()/open(), one venv (venv020), into out-0.2.0/.
set -u
ROOT=$HOME/packmem-hfbench
cd "$ROOT"
export PMB_OUT=$ROOT/out-0.2.0
S=scripts/run2.sh
V=venv020
PY="$ROOT/$V/bin/python -I"
B1=$ROOT/hf/cache_B1
arrows() { find "$1" -name '*.arrow'; }
pc() { local op=$1 name=$2; shift 2; echo "{\"pcache\":\"$op\",\"before\":\"$name\",\"r\":$($PY scripts/pcache.py $op "$@")}" >> $PMB_OUT/runs.jsonl; }
# pause while CI keeps the 1-minute load above 60 (up to 10 minutes), and log it
calm() {
  local n=0
  while (( $(cut -d' ' -f1 /proc/loadavg | cut -d. -f1) > 60 && n < 40 )); do sleep 15; n=$((n+1)); done
  (( n > 0 )) && echo "{\"paused_s\":$((n*15)),\"before\":\"$1\",\"load_after_pause\":$(cut -d' ' -f1 /proc/loadavg)}" >> $PMB_OUT/runs.jsonl
  return 0
}
R() { calm "$2"; $S "$@"; }
phase=${1:-all}
if [[ $phase == all || $phase == prep ]]; then
  echo "{\"phase\":\"prep\",\"t\":\"$(date -Iseconds)\"}" >> $PMB_OUT/runs.jsonl
  R $V prep_ids 8 prep_ids.py
  R $V conv_B1 15 bench_load.py B1 conv $B1
  R $V hash_B1 4 bench_load.py B1 hash $B1
  R $V prep_v2save 4 prep_v2save.py
  R $V hash_V2O 4 bench_load.py V2O hash
  R $V hash_V2S 4 bench_load.py V2S hash
  R $V import_cost 4 import_cost.py
  R $V diag_share_norm 4 diag_share.py norm
fi
if [[ $phase == all || $phase == dl ]]; then
  echo "{\"phase\":\"dl\",\"t\":\"$(date -Iseconds)\"}" >> $PMB_OUT/runs.jsonl
  for k in 1 2 3; do
    for st in fork forkserver; do
      exp=12; [[ $st == forkserver ]] && exp=28
      R $V dl_A_${st}_$k $exp bench_dl2.py A $st
      pc warm dl_B1_${st}_$k $(arrows $B1)
      R $V dl_B1_${st}_$k 4 bench_dl2.py B1 $st $B1
      R $V dl_V2S_${st}_$k 6 bench_dl2.py V2S $st
      pc warm dl_V2O_${st}_$k pkm/mix665k.pkm
      R $V dl_V2O_${st}_$k 4 bench_dl2.py V2O $st
      R $V dl_E_${st}_$k 4 bench_dl2.py E $st
      R $V dl_E0_${st}_$k 4 bench_dl2.py E0 $st
    done
  done
fi
echo "{\"phase_done\":\"$phase\",\"t\":\"$(date -Iseconds)\"}" >> $PMB_OUT/runs.jsonl
touch $PMB_OUT/DONE_$phase
