#!/bin/bash
# usage: run_all_v2.sh MODE DATASETS RUNS TAG   (env MP_CTX, N_SAMPLES pass through)
set -u
H="$(cd "$(dirname "$0")" && pwd)"
B="$(dirname "$(dirname "$H")")"
PY="$B/venv/bin/python"
MODE=$1; DS=$2; RUNS=$3; TAG=$4
mkdir -p "$H/out/$TAG"
echo "$TAG begin $(date '+%T') $(sysctl -n vm.loadavg)" >> "$H/load.log"
for r in $(seq 1 "$RUNS"); do
  for v in orig repo; do
    out="$H/out/$TAG/${v}_${r}"
    ( cd "$H" && /usr/bin/time -l "$PY" -I bench_v2.py "$B/$v" "$MODE" "$DS" "$out.json" ) > "$out.log" 2> "$out.time"
    echo "$(sysctl -n vm.loadavg)" > "$out.load"
  done
done
echo "$TAG end $(date '+%T') $(sysctl -n vm.loadavg)" >> "$H/load.log"
