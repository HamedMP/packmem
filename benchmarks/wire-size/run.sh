#!/bin/bash
# Run on a Linux server: prep data, build the instrumented probe, measure, check, compress; then measure what the
# released packmem writes.
#
#   FLIGHTS=.../flights.jsonl LLAVA=.../llava_v1_5_mix665k.json ISSUES=.../issues.jsonl PACKMEM_NODE=.../node ./run.sh
#
# instrument.py edits the core's writer by exact text, so the probe steps need a checkout of c3f435f (format 3), the
# source they were written against; PACKMEM_NODE is the Node package built from that same checkout, for check.mjs.
# The released-build step installs packmem from npm and runs on any checkout.
# Each step is serial, capped at 40 GB without swap, at nice 10, and logs the load average before and after.
set -euo pipefail
cd "$(dirname "$0")"
. ~/.cargo/env
export CARGO_BUILD_JOBS=8
SIZES=10,100,1000,3000,100000
RELEASE=${RELEASE:-0.3.0}
cap() { systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 "$@"; }
load() { echo "{\"step\": \"$1\", \"when\": \"$2\", \"loadavg\": \"$(cut -d' ' -f1-3 /proc/loadavg)\", \"time\": \"$(date -u +%FT%TZ)\"}" >> results/load.jsonl; }
step() { local name=$1; shift; load "$name" before; cap "$@"; load "$name" after; }
mkdir -p results bytes
{ echo "kernel: $(uname -r)"; echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs) x $(nproc)"; echo "mem: $(free -g | awk '/Mem/{print $2}') GB"; rustc --version; node --version; } > results/machine.txt

[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip -q install brotli==1.1.0

if [ ! -f data/flights.jsonl ]; then
  mkdir -p data
  step prep python3 prep.py "$FLIGHTS" "$LLAVA" "$ISSUES" data | tee results/data.txt
fi

if [ -z "${RELEASE_ONLY:-}" ]; then
  : > results/load.jsonl
  python3 instrument.py
  step build cargo build --release -q --manifest-path probe/Cargo.toml
  : > results/probe.jsonl
  for d in flights chat issues traces logs; do
    step "probe-$d" probe/target/release/probe "data/$d.jsonl" "$d" bytes "$SIZES" >> results/probe.jsonl
  done
  step check node check.mjs "$PACKMEM_NODE" data bytes "$SIZES" | tee results/check.txt
  step compress .venv/bin/python compress.py results/probe.jsonl data bytes > results/sizes.jsonl
fi

# what the released build writes, from npm
mkdir -p release && (cd release && [ -f package.json ] || npm init -y >/dev/null) && (cd release && npm install --no-audit --no-fund --silent "packmem@$RELEASE")
step "release-$RELEASE" node measure_030.mjs release data bytes "$SIZES" results/probe.jsonl > "results/release-$RELEASE.jsonl"
step "release-$RELEASE-compress" .venv/bin/python compress.py "results/release-$RELEASE.jsonl" data bytes > "results/sizes-$RELEASE.jsonl"
echo done
