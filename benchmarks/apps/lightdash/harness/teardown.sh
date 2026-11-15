#!/usr/bin/env bash
# Stop the stack. `--all` also removes its volumes, the built image, the stage, the tools and the clone.
set -euo pipefail
. "$(dirname "$0")/env.sh"
cd "$LDB_STAGE" 2>/dev/null && docker compose down ${1:+-v --rmi local} || true
if [ "${1:-}" = "--all" ]; then
  [ -d "$LDB_STAGE" ] && docker run --rm -v "$LDB_STAGE:/stage" --entrypoint sh "$PG_IMAGE" -c 'rm -rf /stage/* /stage/.env'
  rm -rf "$LDB_STAGE" "$LDB_TOOLS" "$LDB_ROOT/lightdash"
fi
