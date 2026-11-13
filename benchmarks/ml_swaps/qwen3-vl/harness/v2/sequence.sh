#!/bin/bash
H="$(cd "$(dirname "$0")" && pwd)"
V=$BENCH
"$V/wait_load.sh" "$H/load.log"
echo "start $(date '+%F %T') $(uptime)" >> "$H/load.log"
"$H/run_all_v2.sh" build llava665k 5 build665k
MP_CTX=spawn "$H/run_all_v2.sh" loader llava665k 5 loader665k_spawn
MP_CTX=fork "$H/run_all_v2.sh" loader llava665k 5 loader665k_fork
"$H/run_all_v2.sh" pickle llava665k 1 pickle665k
"$H/run_all_v2.sh" build "llava665k%50,llava150k" 5 buildmix
echo "epochs $(date '+%F %T') $(uptime)" >> "$H/load.log"
N_SAMPLES=10000000 MP_CTX=spawn "$H/run_all_v2.sh" loader llava665k 3 epoch665k_spawn
N_SAMPLES=10000000 MP_CTX=fork "$H/run_all_v2.sh" loader llava665k 3 epoch665k_fork
echo "end $(date '+%F %T') $(uptime)" >> "$H/load.log"
echo done
