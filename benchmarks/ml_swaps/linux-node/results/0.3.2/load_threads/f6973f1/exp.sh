set -eo pipefail
export PATH=$HOME/.cargo/bin:$PATH
cd ~/packmem-ljpeak2/f6973f1
F=~/packmem-data/llava_v1_5_mix665k.json
python3 -m venv venv-exp && venv-exp/bin/pip -q install maturin==1.9.6
(cd exp/python && systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 nice -n 10 ../../venv-exp/bin/maturin build -q --release -o ../../wheels-exp 2>&1 | tail -2)
venv-exp/bin/pip -q install wheels-exp/*.whl
waitload() { for i in $(seq 120); do l=$(cut -d" " -f1 /proc/loadavg); awk -v l=$l "BEGIN{exit !(l<=4)}" && return 0; sleep 5; done; }
run() { th=$1; mb=$2; waitload; echo "== exp threads=$th inflight=$mb"; PACKMEM_LOAD_INFLIGHT_MB=$mb systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 -E PACKMEM_LOAD_INFLIGHT_MB=$mb nice -n 10 python3 load_threads.py venv-exp/bin/python $F $th 3 exp-t$th-mb$mb.jsonl kw; }
run 4 4096; run 4 32; run 4 8; run 2 4096
sed -i "s/^fs = .*/import glob; fs = sorted(glob.glob(\"exp-*.jsonl\"))/" med.py
python3 med.py > exp-medians.txt; cat exp-medians.txt
echo EXP_DONE
