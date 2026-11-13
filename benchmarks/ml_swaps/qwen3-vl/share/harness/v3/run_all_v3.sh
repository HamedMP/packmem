#!/bin/bash
# usage: run_all_v3.sh MODE DATASETS RUNS TAG ARM...   (env MP_CTX, N_SAMPLES, DIAG pass through)
# Run r uses the arm order as given when r is odd and reversed when r is even. Before each run: wait for
# load1 <= 4 (max 10 min), record load and memory; after it: record load, and any .pkm the run left behind.
set -u
H="$(cd "$(dirname "$0")" && pwd)"
B="$(dirname "$(dirname "$H")")"
PY="$B/venv/bin/python"
MODE=$1; DS=$2; RUNS=$3; TAG=$4; shift 4; ARMS=("$@")
TMP="$("$PY" -I -c 'import tempfile; print(tempfile.gettempdir())')"
mkdir -p "$H/out/$TAG"
echo "$TAG begin $(date '+%T') $(sysctl -n vm.loadavg)" >> "$H/load.log"
for r in $(seq 1 "$RUNS"); do
  order=("${ARMS[@]}")
  if [ $((r % 2)) -eq 0 ]; then order=(); for ((i=${#ARMS[@]}-1; i>=0; i--)); do order+=("${ARMS[$i]}"); done; fi
  for v in "${order[@]}"; do
    out="$H/out/$TAG/${v}_${r}"
    "$H/wait_load.sh" "$H/load.log" "$TAG/${v}_${r}"
    { echo "start $(date '+%T') $(sysctl -n vm.loadavg)"; vm_stat | grep -E 'Pages (free|inactive|speculative|purgeable)'; sysctl vm.swapusage; } > "$out.load"
    ( cd "$H" && /usr/bin/time -l "$PY" -I bench_v3.py "$B/$v" "$MODE" "$DS" "$out.json" ) > "$out.log" 2> "$out.time"
    echo "end $(date '+%T') $(sysctl -n vm.loadavg)" >> "$out.load"
    pid=$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["pid"])' "$out.json" 2>/dev/null)
    ls "$TMP" | grep -E "^packmem-${pid:-x}-.*\.pkm$" > "$out.pkmleft" || true
  done
done
echo "$TAG end $(date '+%T') $(sysctl -n vm.loadavg)" >> "$H/load.log"
