#!/bin/bash
# share() v2b (7de0b93, wheel 7997bb7b): share() attaches the sharing process to its own file, like save()+open().
# Starts after sequence_v2share.sh has ended. Thin venv-v2b on top of venv. Serial; load <= 4 before each run.
set -u
H="$(cd "$(dirname "$0")" && pwd)"; WK="$(dirname "$(dirname "$H")")"
until grep -q "seq_v2share end" $H/load.log; do sleep 10; done
W=$WK/wheel-v2b/packmem-0.2.0.dev0-cp310-abi3-macosx_11_0_arm64.whl
/opt/homebrew/bin/python3.13 -m venv $WK/venv-v2b
$WK/venv-v2b/bin/pip install -q --no-deps $W 2>&1 | grep -v notice
echo "$WK/venv/lib/python3.13/site-packages" > $WK/venv-v2b/lib/python3.13/site-packages/zz_base_venv.pth
(cd $WK && $WK/venv-v2b/bin/python -I -c "import packmem; print('venv-v2b', packmem.__version__, packmem.__file__)") >> $H/load.log
shasum -a 256 $W >> $H/load.log
echo "seq_v2b start $(date '+%F %T') $(uptime)" >> $H/load.log
MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 3 Y_spawn repo-share@v2b repo-open@v2b
MP_CTX=forkserver "$H/run_all_v3.sh" loader llava665k 3 Y_fork repo-share@v2b repo-open@v2b
MP_CTX=fork "$H/run_all_v3.sh" loader llava665k 3 Y_forkctx repo repo-share@v2b
echo "seq_v2b timed_done $(date '+%F %T') $(uptime)" >> $H/load.log
DIAG=1 MP_CTX=spawn "$H/run_all_v3.sh" loader llava665k 1 Y_diag_spawn repo-share@v2b repo-open@v2b
(cd $H && $WK/venv-v2/bin/python -I v2probe.py $H/out/v2probe_v2.json > /dev/null 2>&1)
(cd $H && $WK/venv-v2b/bin/python -I v2probe.py $H/out/v2probe_v2b.json > /dev/null 2>&1)
echo "seq_v2b end $(date '+%F %T') $(uptime)" >> $H/load.log
echo done
