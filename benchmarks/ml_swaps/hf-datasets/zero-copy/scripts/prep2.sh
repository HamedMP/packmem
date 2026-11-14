set -u
cd ~/packmem-hfbench
S=scripts/run2.sh
echo "{\"phase\":\"prep\",\"t\":\"$(date -Iseconds)\"}" >> out2/runs.jsonl
$S venv prep_ids 8 prep_ids.py
$S venv conv_B1 15 bench_load.py B1 conv hf/cache_B1
$S venv hash_B1 4 bench_load.py B1 hash hf/cache_B1
$S venv2 prep_v2save 4 prep_v2save.py
$S venv2 hash_C_v2 4 bench_load.py C hash
$S venv2 hash_V2O 4 bench_load.py V2O hash
$S venv hash_C 4 bench_load.py C hash
echo PREP_DONE
