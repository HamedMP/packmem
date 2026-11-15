set -eo pipefail
export PATH=$HOME/.cargo/bin:$PATH
while pgrep -u $(id -u) -f "bash exp.sh" >/dev/null; do sleep 5; done
cd ~/packmem-ljpeak2/752a515
F=~/packmem-data/llava_v1_5_mix665k.json
python3 -m venv venv && venv/bin/pip -q install maturin==1.9.6
(cd src/python && systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 nice -n 10 ../../venv/bin/maturin build -q --release -o ../../wheels 2>&1 | tail -2)
venv/bin/pip -q install wheels/*.whl
sha256sum wheels/*.whl >> commit.txt; rustc --version >> commit.txt
waitload() { for i in $(seq 120); do l=$(cut -d" " -f1 /proc/loadavg); awk -v l=$l "BEGIN{exit !(l<=4)}" && return 0; sleep 5; done; }
run() { th=$1; mb=$2; waitload; echo "== threads=$th inflight=$mb"; PACKMEM_LOAD_INFLIGHT_MB=$mb systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 -E PACKMEM_LOAD_INFLIGHT_MB=$mb nice -n 10 python3 load_threads.py venv/bin/python $F $th 3 runs-t$th-mb$mb.jsonl kw; }
run 1 32
for mb in 4096 32 16; do run 4 $mb; done
for mb in 4096 32; do run 2 $mb; done
python3 med.py | tee medians.txt
echo SWEEP_DONE
