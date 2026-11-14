#!/bin/bash
set -u
D=$HOME/packmem-subcol; H=$D/harness/linux; O=$D/out/gate4; mkdir -p $O
export RUSTUP_HOME=$D/rust/rustup CARGO_HOME=$D/rust/cargo
git -C $D/build fetch -q origin && git -C $D/build checkout -q a456190 || { echo "gate4 checkout failed" >> $D/load.log; exit 1; }
rm -rf $D/wheels/cand4; (cd $D/build/python && PATH=$CARGO_HOME/bin:$PATH CARGO_TARGET_DIR=$D/target $D/venv-build/bin/maturin build --release -o $D/wheels/cand4 > $D/gate4_build.log 2>&1) || { echo "gate4 build failed" >> $D/load.log; exit 1; }
echo "gate4 built $(git -C $D/build rev-parse HEAD) $(sha256sum $D/wheels/cand4/*.whl)" >> $D/load.log
for v in $D/venv-cand $D/llava-next/venv-cand; do $v/bin/pip install -q --force-reinstall --no-deps $D/wheels/cand4/*.whl; done
export PACKMEM_THREADS=1
sc(){ systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 env PACKMEM_THREADS=1 "$@"; }
J=$D/data/llava_v1_5_mix665k.json
for i in 1 2 3; do for v in cand 020; do sc python3 $H/phasesample.py $O/phase_qwen_${v}_$i.json $D/venv-$v/bin/python $J; done; done
for i in 1 2 3 4 5; do
  order="cand 020"; [ $((i%2)) -eq 0 ] && order="020 cand"
  for v in $order; do
    l0=$(cut -d" " -f1-3 /proc/loadavg)
    (cd $D/harness/v3 && sc python3 $H/peaksample.py $O/qwen_${v}_$i.peak.json -- $D/venv-$v/bin/python -I $D/harness/v3/bench_v3.py $D/repo build llava665k $O/qwen_${v}_$i.json)
    (cd $D/llava-next/harness/v2 && sc python3 $H/peaksample.py $O/llava_${v}_$i.peak.json -- $D/llava-next/venv-$v/bin/python -I run_v2.py $D/llava-next/repo $D/llava-next/data/mix.yaml --workers 0)
    echo "gate4 run $i $v load $l0 -> $(cut -d" " -f1-3 /proc/loadavg)" >> $D/load.log
  done
done
echo "gate4 done $(date +%T)" >> $D/load.log
