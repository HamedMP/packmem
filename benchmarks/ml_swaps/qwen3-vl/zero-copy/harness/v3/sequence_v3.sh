#!/bin/bash
# Every step runs one benchmark process at a time. Orig joins the spawn configurations only if
# free + inactive + speculative + purgeable memory is at least 25 GB (v2: 23.5 GB peak sum).
H="$(cd "$(dirname "$0")" && pwd)"
avail() { vm_stat | awk '/Pages (free|inactive|speculative|purgeable)/ {gsub("\\.","",$NF); s+=$NF} END {printf "%.0f", s*16384}'; }
spawn_arms() {
  a=$(avail); echo "$1 available_bytes=$a $(sysctl vm.swapusage)" >> "$H/load.log"
  if [ "$a" -ge 25000000000 ]; then echo "orig repo repo-share"; else echo "repo repo-share"; fi
}
echo "start $(date '+%F %T') $(uptime)" >> "$H/load.log"
"$H/run_all_v3.sh" verify llava665k 1 verify665k orig repo repo-share
"$H/run_all_v3.sh" hash llava665k 1 hash20k orig
N_SAMPLES=10000000 "$H/run_all_v3.sh" hash llava665k 1 hashepoch orig
"$H/run_all_v3.sh" pickle llava665k 1 pickle665k orig repo repo-share
ARMS=$(spawn_arms A)
MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 3 A_spawn20k $ARMS
ARMS=$(spawn_arms B)
N_SAMPLES=10000000 MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 3 B_epoch_spawn $ARMS
DIAG=1 MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 1 diag_spawn20k repo repo-share
echo "end $(date '+%F %T') $(uptime)" >> "$H/load.log"
echo done
