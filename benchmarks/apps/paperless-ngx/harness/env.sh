# Sourced by the server-side scripts.
set -euo pipefail

WORK="${WORK:-$HOME/packmem-paperless}"
H="$WORK/harness"
RES="$WORK/results"
PROJECT=packmem-paperless

PAPERLESS_IMAGE="ghcr.io/paperless-ngx/paperless-ngx:3.4.2@sha256:d704e84f88300eb6ab001ab15720a2330ff99169cf9f94d6b8fcc44b63a84c84"
PAPERLESS_TAG=v3.4.2
PAPERLESS_COMMIT=d939d873e11dd14896d1bfe23f65b1baa6513ba7
EXPORTER_ORIG_SHA256=4fff582ed9f2d5f55ec9cc75a4adb01571483e761d2940b21eccb923e01acf9e

PACKMEM_020_WHEEL=packmem-0.2.0-cp310-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl
PACKMEM_020_URL="https://files.pythonhosted.org/packages/93/ef/d6078790bdb0e8f84acd248682e90f028708c00770eb0f03d1773ae4f0ff/$PACKMEM_020_WHEEL"
PACKMEM_020_SHA256=09c5ba04ee380af34600af1c9d6fac3f3a0337ebeb19f75292eb6423633614c7
PACKMEM_MAIN_COMMIT=b48a51992985c8d2a441c191550b18265f27963a
MATURIN_VERSION=1.9.6

SEED=20261114
DB_100K=paperless
DB_20K=paperless_20k

SRC=/usr/src/paperless/src
EXPORT=/usr/src/paperless/export

dc() {
  docker compose -p "$PROJECT" \
    -f "$WORK/compose/docker-compose.postgres.yml" \
    -f "$H/compose.override.yml" "$@"
}

# Run a command in the webserver container as the paperless user, from src/.
in_web() {
  dc exec -T -u paperless -w "$SRC" webserver "$@"
}

loadavg() { cut -d' ' -f1-3 /proc/loadavg; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }

ensure_time() {
  if ! dc exec -T webserver test -x /usr/bin/time; then
    log "installing GNU time in the webserver container"
    dc exec -T -u root webserver bash -c \
      'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends time >/dev/null'
  fi
  dc exec -T webserver /usr/bin/time --version | head -1
}

# Throwaway secret for this benchmark-only stack (no ports published); generated once, kept out of results.
if [[ ! -s "$WORK/.secret_key" ]]; then
  mkdir -p "$WORK"; (umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(64))' > "$WORK/.secret_key")
fi
export PAPERLESS_SECRET_KEY="$(cat "$WORK/.secret_key")"
