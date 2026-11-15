#!/usr/bin/env bash
# Build everything the runs need, outside this repository (under $LDB_ROOT), then start the stack.
# Idempotent; heavy steps run under nice. Nothing here is timed.
set -euo pipefail
. "$(dirname "$0")/env.sh"
N="nice -n 19"
export NODE_PATH="$LDB_TOOLS/node_modules"
ESBUILD="$LDB_TOOLS/node_modules/.bin/esbuild"
mkdir -p "$LDB_ROOT" "$LDB_TOOLS"
cd "$LDB_ROOT"

# 1. Lightdash at the pinned release.
if [ ! -d lightdash ]; then $N git clone -q --depth 1 --branch "$LD_VERSION" https://github.com/lightdash/lightdash.git; fi
test "$(git -C lightdash rev-parse HEAD)" = "$LD_COMMIT" || { echo "lightdash is not at $LD_COMMIT" >&2; exit 1; }

# 2. Tools: TypeScript for the transpile, packmem for the client bundle, esbuild, Playwright and its Chromium.
cd "$LDB_TOOLS"
[ -f package.json ] || npm init -y > /dev/null
$N npm install --no-audit --no-fund --silent typescript@$TYPESCRIPT_VERSION packmem@$PACKMEM_VERSION \
  esbuild@$ESBUILD_VERSION playwright@$PLAYWRIGHT_VERSION
$N ./node_modules/.bin/playwright install chromium > /dev/null

# 3. The stage: the demo's dbt project, profile and entrypoint, MinIO's init script, and this harness's files.
# dbt in the container writes target/ and logs/ as root, so the old stage is removed from inside a container.
if [ -d "$LDB_STAGE" ]; then
  (cd "$LDB_STAGE" && docker compose down -v 2>/dev/null) || true
  docker run --rm -v "$LDB_STAGE:/stage" --entrypoint sh "$PG_IMAGE" -c 'rm -rf /stage/* /stage/.env'
  rm -rf "$LDB_STAGE"
fi
mkdir -p "$LDB_STAGE/logs" "$LDB_STAGE/bench"
DEMO="$LDB_ROOT/lightdash/examples/full-jaffle-shop-demo"
cp -r "$DEMO/dbt" "$DEMO/profiles" "$DEMO/entrypoint.sh" "$LDB_STAGE/"
cp "$LDB_ROOT/lightdash/docker/init-minio.sh" "$LDB_STAGE/"
cp "$LDB_HARNESS/Dockerfile" "$LDB_HARNESS/docker-compose.yml" "$LDB_HARNESS/nginx.conf" "$LDB_STAGE/"
chmod 777 "$LDB_STAGE/logs"
# Compose reads its pins from .env, so `docker compose ...` in the stage works without sourcing env.sh.
for v in COMPOSE_PROJECT_NAME LD_VERSION LD_IMAGE PG_IMAGE MINIO_IMAGE NGINX_IMAGE PACKMEM_VERSION LDB_PORT LDB_URL; do
  echo "$v=${!v}"
done > "$LDB_STAGE/.env"

# 4. The seed: raw_product_events scaled to $PRODUCT_EVENTS_ROWS rows.
python3 "$LDB_HARNESS/seed.py" "$DEMO/dbt/data/raw_product_events.csv" "$LDB_STAGE/dbt/data/raw_product_events.csv" \
  "$PRODUCT_EVENTS_ROWS" | tee "$LDB_STAGE/seed.txt"

# 5. The controller: check the transpile reproduces the image's copy, then transpile the patched source.
SRC=packages/backend/src/controllers/v2/QueryController.ts
docker run --rm --entrypoint cat "$LD_IMAGE" dist/controllers/v2/QueryController.js > "$LDB_STAGE/QueryController.image.js"
node "$LDB_HARNESS/transpile.cjs" "$LDB_ROOT/lightdash/$SRC" "$LDB_STAGE/QueryController.unpatched.js"
norm() { grep -v -e sourceMappingURL -e _sentryDebugIds "$1" | "$ESBUILD" --format=cjs --legal-comments=none --log-level=error; }
diff <(norm "$LDB_STAGE/QueryController.image.js") <(norm "$LDB_STAGE/QueryController.unpatched.js") > /dev/null \
  || { echo "transpile does not reproduce the image's QueryController.js" >&2; exit 1; }
rm -rf "$LDB_STAGE/src" && mkdir -p "$LDB_STAGE/src"
cp "$LDB_ROOT/lightdash/$SRC" "$LDB_STAGE/src/QueryController.ts"
patch -s "$LDB_STAGE/src/QueryController.ts" "$LDB_HARNESS/QueryController.packmem.patch"
node "$LDB_HARNESS/transpile.cjs" "$LDB_STAGE/src/QueryController.ts" "$LDB_STAGE/QueryController.js"

# 6. The browser side: the page and its bundle (packmem/http + packmem/wasm from npm), served by the proxy.
cp "$LDB_HARNESS/client/index.html" "$LDB_STAGE/bench/"
"$ESBUILD" "$LDB_HARNESS/client/bench.js" --bundle --format=esm \
  --platform=browser --target=es2022 --log-level=error --outfile="$LDB_STAGE/bench/bench.js"
cp "$LDB_TOOLS/node_modules/packmem/wasm-dist/packmem_bg.wasm" "$LDB_STAGE/bench/packmem.wasm"

# 7. Build and start. The entrypoint seeds dbt and Lightdash's demo org and project on every start; its first step
# rolls back every migration, which 3.261.1 cannot do once migrated (an irreversible migration), so every start
# needs a fresh database: `docker compose down -v` first.
cd "$LDB_STAGE"
$N docker compose build -q
docker compose up -d
for i in $(seq 600); do
  curl -sf "$LDB_URL/api/v1/health" > /dev/null && break
  [ "$(docker compose ps -a lightdash --format '{{.State}}')" = exited ] && break
  sleep 2
done
curl -sf "$LDB_URL/api/v1/health" > /dev/null || { docker compose logs --tail 80 lightdash; exit 1; }
echo "lightdash up at $LDB_URL"
