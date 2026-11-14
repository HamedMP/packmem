#!/bin/bash
# Run locally: stage patches and harness into ~/packmem-subcol on the server, then run setup and the gate there.
set -eu
WK="$(cd "$(dirname "$0")/../.." && pwd)"; HOST=${HOST:-linux-server}; D=packmem-subcol
ssh $HOST "mkdir -p ~/$D/patches ~/$D/harness/v3 ~/$D/harness/linux ~/$D/llava-next/harness"
rsync -a $WK/packmem.v3.patch $WK/open.patch $WK/llava.packmem.v2.patch $HOST:$D/patches/
rsync -a $WK/harness/v3/{bench_v3.py,wprobe.py,memlinux.py,subcol.py} $HOST:$D/harness/v3/
rsync -a $WK/harness/linux/ $HOST:$D/harness/linux/
rsync -a --exclude __pycache__ $WK/llava-next/harness/ $HOST:$D/llava-next/harness/
echo "staged; next: ssh $HOST '~/$D/harness/linux/setup_server.sh && nohup ~/$D/harness/linux/sequence_subcol_linux.sh > ~/$D/seq.out 2>&1 &'"
