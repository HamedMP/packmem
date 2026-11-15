set -eo pipefail
export PATH=$HOME/.cargo/bin:$PATH
cd ~/packmem-ljpeak2/5df3b63
env | grep -c "^MALLOC_" || true
F=~/packmem-data/llava_v1_5_mix665k.json
git clone -q --filter=blob:none https://github.com/HamedMP/packmem.git src && (cd src && git checkout -q 5df3b63 && git log --oneline -1) > build.txt
python3 -m venv venv && venv/bin/pip -q install maturin==1.9.6
(cd src/python && systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 nice -n 10 ../../venv/bin/maturin build -q --release -o ../../wheels 2>&1 | tail -2)
venv/bin/pip -q install wheels/*.whl
sha256sum wheels/*.whl >> build.txt; rustc --version >> build.txt
waitload() { for i in $(seq 120); do l=$(cut -d" " -f1 /proc/loadavg); awk -v l=$l "BEGIN{exit !(l<=4)}" && return 0; sleep 5; done; }
for th in 1 2 4; do waitload; echo "== threads=$th"; systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 python3 load_threads.py venv/bin/python $F $th 3 runs-t$th.jsonl kw; done
for b in 5df3b63:venv f6973f1:../f6973f1/venv 5df3b63:venv f6973f1:../f6973f1/venv; do waitload; systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 ${b#*:}/bin/python qtime.py $F ${b%%:*} | tee -a query.jsonl; done
python3 med2.py runs-t1.jsonl runs-t2.jsonl runs-t4.jsonl | tee medians.txt
echo RUN_DONE
