#!/bin/sh
# Phase 2: full LLaVA-665k through NeMo Automodel's make_meta_dataset, original vs packmem.
# Every measurement is a fresh process; arms are interleaved within each round.
# usage: harness/bench.sh [prep|verify|build|pickle|loader|leak|all]   (ROUNDS=5 by default)
set -eu
W=$(cd "$(dirname "$0")/.." && pwd)
PY="$W/venv/bin/python -I"
SRC="$W/../fit-sweep/bench/OpenBMB__MiniCPM-V/data/dl/llava_v1_5_mix665k.json"
META="$W/data/llava665k.meta.json"
PROC="$W/models/qwen2_5_vl_3b_processor"
OUT="$W/results/phase2.jsonl"
ROUNDS=${ROUNDS:-5}
ARMS="automodel automodel-packmem"
mkdir -p "$W/results"
cd "$W"

run() { # run <repo> <args...>; stderr kept per run
  repo=$1; shift
  $PY harness/run.py --repo "$repo" --meta "$META" --out "$OUT" --tag p2 "$@" 2>>"$W/results/phase2.err" >/dev/null
}

prep() {
  [ -f "$W/data/llava665k.json" ] || $PY harness/convert.py "$SRC" "$W/data/llava665k.json"
}

verify() { # full-data equality: per-example digests, samplers, collate outputs
  for a in $ARMS; do
    $PY harness/run.py --repo $a --meta "$META" --mode dump --processor "$PROC" \
      --digests "$W/results/digests665k-$a.txt" --out "$W/results/phase2-dump.jsonl" --tag p2 2>>"$W/results/phase2.err" >/dev/null
  done
  cmp "$W/results/digests665k-automodel.txt" "$W/results/digests665k-automodel-packmem.txt" && echo "665k digests identical"
}

build() {
  for i in $(seq "$ROUNDS"); do for a in $ARMS; do
    run $a --mode build
    run $a --mode build --shard
  done; done
}

pickle_() {
  for i in $(seq 3); do for a in $ARMS; do run $a --mode pickle; done; done
}

loader() { # recipe path: VlmDataloaderConfig(MetaDatasetConfig), num_workers=4, 64 batches of 8
  for i in $(seq "$ROUNDS"); do for sm in spawn fork; do for a in $ARMS; do
    run $a --mode loader --processor "$PROC" --workers 4 --start-method $sm --batches 64
    run $a --mode loader --processor "$PROC" --workers 4 --start-method $sm --batches 64 --shard
  done; done; done
}

leak() { # pretokenize pipeline under fork: records gain decoded images in the list arm
  for i in $(seq 3); do for a in $ARMS; do
    run $a --mode loader --processor "$PROC" --workers 4 --start-method fork --pipeline pretokenize \
      --fake-image coco --batches 256
  done; done
}

case "${1:-all}" in
  prep) prep ;;
  verify) verify ;;
  build) build ;;
  pickle) pickle_ ;;
  loader) loader ;;
  leak) leak ;;
  all) prep; verify; build; pickle_; loader; leak ;;
esac
$PY harness/summarize.py "$OUT"
