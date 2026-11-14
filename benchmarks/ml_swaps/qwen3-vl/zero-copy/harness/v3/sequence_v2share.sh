#!/bin/bash
# Zero-copy share() v2 on Qwen3-VL, 4 workers, 20k samples, median of 3, arms interleaved, load <= 4 (max 10 min).
#   repo@(venv = candidate 630df090)  plain pickle
#   repo-share@f34d                   share() v1 (copy on attach)
#   repo-share@v2                     share() v2 (map in place), wheel f9f57281
#   repo-open@v2                      save(path) + packmem.open(path)
# warm = the .pkm as share()/save() left it; cold = rewritten through F_NOCACHE into a fresh inode before iter(dl).
set -u
H="$(cd "$(dirname "$0")" && pwd)"
echo "seq_v2share start $(date '+%F %T') $(uptime)" >> $H/load.log
ARMS="repo repo-share@f34d repo-share@v2 repo-open@v2"
MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 3 Z_spawn $ARMS
MP_CTX=forkserver "$H/run_all_v3.sh" loader llava665k 3 Z_fork $ARMS
PKM_COLD=1 MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 3 Z_spawn_cold repo-share@f34d repo-share@v2 repo-open@v2
PKM_COLD=1 MP_CTX=forkserver "$H/run_all_v3.sh" loader llava665k 3 Z_fork_cold repo-share@f34d repo-share@v2 repo-open@v2
echo "seq_v2share timed_done $(date '+%F %T') $(uptime)" >> $H/load.log
DIAG=1 MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 1 Z_diag_spawn $ARMS
DIAG=1 MP_CTX=forkserver "$H/run_all_v3.sh" loader llava665k 1 Z_diag_fork $ARMS
echo "seq_v2share end $(date '+%F %T') $(uptime)" >> $H/load.log
echo done
