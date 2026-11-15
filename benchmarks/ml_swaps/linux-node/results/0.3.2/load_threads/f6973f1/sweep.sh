set -eo pipefail
export PATH=$HOME/.cargo/bin:$PATH
cd ~/packmem-ljpeak2/f6973f1
F=~/packmem-data/llava_v1_5_mix665k.json
python3 -m venv venv && venv/bin/pip -q install maturin==1.9.6
(cd src/python && systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 nice -n 10 ../../venv/bin/maturin build -q --release -o ../../wheels 2>&1 | tail -2)
venv/bin/pip -q install wheels/*.whl
sha256sum wheels/*.whl >> commit.txt; rustc --version >> commit.txt
waitload() { for i in $(seq 120); do l=$(cut -d" " -f1 /proc/loadavg); awk -v l=$l "BEGIN{exit !(l<=4)}" && return 0; sleep 5; done; echo "load still $(cut -d' ' -f1 /proc/loadavg)"; }
run() { th=$1; mb=$2; waitload; echo "== threads=$th inflight=$mb"; PACKMEM_LOAD_INFLIGHT_MB=$mb systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 -E PACKMEM_LOAD_INFLIGHT_MB=$mb nice -n 10 python3 load_threads.py venv/bin/python $F $th 3 runs-t$th-mb$mb.jsonl kw; }
run 1 32
for mb in 4096 48 32 16 8; do run 4 $mb; done
for mb in 4096 32; do run 2 $mb; done
cat > pieces.py <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
out = []
for i in range(0, len(rows), 16384):
    out.append(sum(len(json.dumps(r)) for r in rows[i:i+16384]))
json.dump({"records": len(rows), "piece_records": 16384, "piece_bytes": out}, open("piece_bytes.json", "w"))
print(len(out), "pieces; MB:", " ".join(f"{b/1e6:.0f}" for b in out))
PY
systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 venv/bin/python pieces.py $F
echo SWEEP_DONE
