#!/usr/bin/env bash
# Correctness on a small query (6,000 rows: 12 pages of 500, 3 of 2,500) plus the memory-method check.
# Nothing timed is kept from this; it only shows the arms agree and the readings move as expected.
set -euo pipefail
. "$(dirname "$0")/env.sh"
export NODE_PATH="$LDB_TOOLS/node_modules"
OUT=${1:-$LDB_ROOT/raw/smoke.jsonl}
mkdir -p "$(dirname "$OUT")" && : > "$OUT"
cd "$LDB_TOOLS"
nice -n 19 node "$LDB_HARNESS/run.mjs" --out "$OUT" --limit "${SMOKE_ROWS:-6000}" --rounds 1 --memcheck
