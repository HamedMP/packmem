#!/bin/bash
# hint="compact" vs default, real LLaVA mix, on the compact wheel (venv-compact). Serial, capped, niced.
D=$HOME/packmem-subcol; PY=$D/venv-compact/bin/python; B=$D/harness/linux/compact_bench.py; J=$D/data/llava_v1_5_mix665k.json
O=$D/out/compact; mkdir -p $O
run() { # tag, env..., args
  tag=$1; shift
  echo "$(date '+%F %T') start $tag $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
  systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 env "$@" > $O/$tag.log 2>&1
  echo "$(date '+%F %T') end $tag rc=$? $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
}
for i in 1 2 3; do
  for h in balanced compact; do run build_${h}_$i $PY -I $B $J $h $O/build_${h}_$i.json build; done
done
run build_compact_L9 PACKMEM_ZSTD_LEVEL=9 $PY -I $B $J compact $O/build_compact_L9.json build
run build_balanced_L9ref PACKMEM_ZSTD_LEVEL=9 $PY -I $B $J balanced $O/build_balanced_L9ref.json build
for h in balanced compact; do run workers_$h $PY -I $B $J $h $O/workers_$h.json workers; done
for h in balanced compact; do run verify_$h $PY -I $B $J $h $O/verify_$h.json verify; done
$PY -I -c "import packmem; print('stale removed', packmem.cleanup_stale())" >> $O/cleanup.log 2>&1
echo "seq_compact end $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
