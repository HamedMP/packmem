#!/bin/bash
# Browser benchmark, run on a Linux server: install, prepare the data, run, summarize.
#
#   FLIGHTS=.../flights.jsonl LLAVA=.../llava_v1_5_mix665k.json ISSUES=.../issues.jsonl ./run.sh
#
# FLIGHTS: nycflights13 as JSON lines (data/flights.jsonl in this repository's data download).
# LLAVA:   llava_v1_5_mix665k.json from liuhaotian/LLaVA-Instruct-150K on Hugging Face.
# ISSUES:  ~3,000 public facebook/react issues as the GitHub API returns them, one per line, e.g.
#          gh api --paginate 'repos/facebook/react/issues?state=all&per_page=100' --jq '.[] | @json' | head -3000
# Traces and logs are generated (seeded) by ../wire-size/prep.py.
# Each dataset runs serially, capped at 40 GB without swap, at nice 10; the load average is logged per dataset.
set -euo pipefail
cd "$(dirname "$0")"
cap() { systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 nice -n 10 "$@"; }
mkdir -p data results
npm install --no-audit --no-fund --silent
npx playwright-core install chromium >/dev/null
[ -f data/flights.jsonl ] || python3 ../wire-size/prep.py "$FLIGHTS" "$LLAVA" "$ISSUES" data | tee results/data.txt
{ echo "kernel: $(uname -r)"; echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs) x $(nproc)";
  echo "mem: $(free -g | awk '/Mem/{print $2}') GB"; echo "node: $(node --version)";
  echo "packmem: $(node -p 'require("packmem/package.json").version')"; } > results/machine.txt
: > results/runs.jsonl
: > results/load.jsonl
for d in ${DATASETS:-flights chat issues traces logs}; do
  echo "{\"dataset\": \"$d\", \"when\": \"before\", \"loadavg\": \"$(cut -d' ' -f1-3 /proc/loadavg)\"}" >> results/load.jsonl
  cap node bench.mjs data results/runs.jsonl "${RUNS:-7}" "$d"
  echo "{\"dataset\": \"$d\", \"when\": \"after\", \"loadavg\": \"$(cut -d' ' -f1-3 /proc/loadavg)\"}" >> results/load.jsonl
done
node summarize.mjs results/runs.jsonl > results/tables.md
echo done
