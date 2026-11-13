#!/bin/bash
# usage: run_all.sh MODE DATASETS RUNS TAG   (env N_SAMPLES passes through)
set -u
H="$(cd "$(dirname "$0")" && pwd)"
B="$(dirname "$H")"
PY="$B/venv/bin/python"
MODE=$1; DS=$2; RUNS=$3; TAG=$4
mkdir -p "$H/out/$TAG"
for r in $(seq 1 "$RUNS"); do
  for v in orig repo; do
    out="$H/out/$TAG/${v}_${r}"
    ( cd "$H" && /usr/bin/time -l "$PY" -I bench.py "$B/$v" "$MODE" "$DS" "$out.json" ) 2> "$out.time"
  done
done
