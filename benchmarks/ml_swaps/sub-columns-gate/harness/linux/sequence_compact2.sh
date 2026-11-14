#!/bin/bash
# hint="compact" sweep on main 7b5dd99: block in {512,1024,2048} x dict in {256,1024} KB at level 3; level 9 at two points; default hint for reference.
D=$HOME/packmem-subcol; PY=$D/venv-compact/bin/python; B=$D/harness/linux/compact_bench.py; J=$D/data/llava_v1_5_mix665k.json
O=$D/out/compact2; mkdir -p $O
run() { tag=$1; shift; echo "$(date '+%F %T') start $tag $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
  systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 env "$@" > $O/$tag.log 2>&1
  echo "$(date '+%F %T') end $tag rc=$? $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log; }
for i in 1 2; do run build_default_$i $PY -I $B $J balanced $O/build_default_$i.json build; done
run workers_default $PY -I $B $J balanced $O/workers_default.json workers
for blk in 512 1024 2048; do for dk in 256 1024; do t=b${blk}_d${dk}
  for i in 1 2; do run build_${t}_$i PACKMEM_ZSTD_BLOCK=$blk PACKMEM_ZSTD_DICT_KB=$dk $PY -I $B $J compact $O/build_${t}_$i.json build; done
  run workers_$t PACKMEM_ZSTD_BLOCK=$blk PACKMEM_ZSTD_DICT_KB=$dk $PY -I $B $J compact $O/workers_$t.json workers
done; done
for t in "1024 256" "1024 1024"; do set -- $t
  run build_b$1_d$2_L9 PACKMEM_ZSTD_LEVEL=9 PACKMEM_ZSTD_BLOCK=$1 PACKMEM_ZSTD_DICT_KB=$2 $PY -I $B $J compact $O/build_b$1_d$2_L9.json build; done
run verify_b1024_d256 PACKMEM_ZSTD_BLOCK=1024 PACKMEM_ZSTD_DICT_KB=256 $PY -I $B $J compact $O/verify_b1024_d256.json verify
run verify_default $PY -I $B $J balanced $O/verify_default.json verify
$PY -I -c "import packmem; print('stale removed', packmem.cleanup_stale())" >> $O/cleanup.log 2>&1
echo "seq_compact2 end $(date '+%F %T') $(cut -d' ' -f1-3 /proc/loadavg)" >> $D/load.log
