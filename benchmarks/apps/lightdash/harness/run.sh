#!/usr/bin/env bash
# The timed runs: a fresh stack, one warm-up round (kept, marked), then $ROUNDS rounds of every arm at the full query
# size, the arm order rotating each round. Run only when nothing else is benchmarking on the machine. Each round
# first waits up to 10 minutes for a 1-minute load of 4 or less; arms that start above it are marked noisy.
#   bash harness/run.sh [rounds]
set -euo pipefail
. "$(dirname "$0")/env.sh"
export NODE_PATH="$LDB_TOOLS/node_modules"
ROUNDS=${1:-5}
RAW="$LDB_ROOT/raw/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RAW"

cd "$LDB_STAGE"
docker compose down -v > /dev/null 2>&1 || true
docker compose up -d > /dev/null 2>&1
for i in $(seq 600); do
  curl -sf "$LDB_URL/api/v1/health" > /dev/null && break
  [ "$(docker compose ps -a lightdash --format '{{.State}}')" = exited ] && break
  sleep 2
done
curl -sf "$LDB_URL/api/v1/health" > /dev/null || { docker compose logs --tail 80 lightdash; exit 1; }

cp seed.txt "$RAW/"
echo "start $(date -u +%FT%TZ) load $(cut -d' ' -f1-3 /proc/loadavg)" > "$RAW/load.txt"
cd "$LDB_TOOLS"
node "$LDB_HARNESS/run.mjs" --out "$RAW/warmup.jsonl" --limit "$PRODUCT_EVENTS_ROWS" --rounds 1 --memcheck
node "$LDB_HARNESS/run.mjs" --out "$RAW/runs.jsonl" --limit "$PRODUCT_EVENTS_ROWS" --rounds "$ROUNDS"
echo "end $(date -u +%FT%TZ) load $(cut -d' ' -f1-3 /proc/loadavg)" >> "$RAW/load.txt"
cp "$LDB_STAGE/logs/bench.jsonl" "$RAW/proxy.jsonl"
(cd "$LDB_STAGE" && docker compose logs --no-color lightdash > "$RAW/lightdash.log" 2>&1) || true
echo "raw output in $RAW"
