set -eo pipefail
export PATH=$HOME/.cargo/bin:$PATH
cd ~/packmem-ljpeak2/f6973f1
F=~/packmem-data/llava_v1_5_mix665k.json
python3 -m venv venv-dbg && venv-dbg/bin/pip -q install maturin==1.9.6 memray==1.20.0
(cd src/python && CARGO_PROFILE_RELEASE_DEBUG=1 CARGO_PROFILE_RELEASE_STRIP=false systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 -E CARGO_PROFILE_RELEASE_DEBUG=1 -E CARGO_PROFILE_RELEASE_STRIP=false nice -n 10 ../../venv-dbg/bin/maturin build -q --release -o ../../wheels-dbg 2>&1 | tail -2)
venv-dbg/bin/pip -q install wheels-dbg/*.whl
sha256sum wheels-dbg/*.whl >> commit.txt
cp ../prof.py .
for mb in 8 4096; do
  PACKMEM_LOAD_INFLIGHT_MB=$mb systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 -E PACKMEM_LOAD_INFLIGHT_MB=$mb nice -n 10 venv-dbg/bin/memray run -q --native -f -o t4-mb$mb.bin prof.py $F 4
  venv-dbg/bin/memray stats t4-mb$mb.bin > stats-t4-mb$mb.txt 2>&1 || true
  nice -n 10 venv-dbg/bin/memray transform csv -f -o hwm-t4-mb$mb.csv t4-mb$mb.bin > /dev/null 2>&1
done
python3 agg3.py hwm-t4-mb8.csv hwm-t4-mb4096.csv > agg-f6973f1.txt
echo PROF_DONE
