#!/bin/sh
# Loader + leak runs sized to this 48 GB Mac (the full list under spawn x4 would need ~40 GB).
set -eu
W=$(cd "$(dirname "$0")/.." && pwd); cd "$W"
PY="$W/venv/bin/python -I"; META="$W/data/llava665k.meta.json"; PROC="$W/models/qwen2_5_vl_3b_processor"; OUT="$W/results/phase2.jsonl"
run() { repo=$1; shift; $PY harness/run.py --repo "$repo" --meta "$META" --out "$OUT" --tag p2 "$@" 2>>"$W/results/phase2.err" >/dev/null; }
for i in 1 2 3; do for a in automodel automodel-packmem; do
  run $a --mode loader --processor "$PROC" --workers 4 --start-method fork  --batches 64
  run $a --mode loader --processor "$PROC" --workers 4 --start-method fork  --batches 64 --shard
  run $a --mode loader --processor "$PROC" --workers 4 --start-method spawn --batches 64 --shard
  run $a --mode loader --processor "$PROC" --workers 1 --start-method spawn --batches 64
done; done
for i in 1 2 3; do for a in automodel automodel-packmem; do
  run $a --mode loader --processor "$PROC" --workers 4 --start-method fork --pipeline pretokenize --fake-image coco --batches 256
done; done
$PY harness/summarize.py "$OUT"
