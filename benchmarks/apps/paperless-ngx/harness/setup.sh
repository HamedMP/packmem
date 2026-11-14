#!/usr/bin/env bash
# Pull the pinned images, fetch packmem 0.2.0, start Paperless with the patched
# exporter mounted. Run on the server: bash ~/packmem-paperless/harness/setup.sh
source "$(dirname "$0")/env.sh"

mkdir -p "$RES/env" "$RES/logs" "$WORK/compose/consume" "$WORK/pm" "$WORK/wheels"

v=$(docker compose version --short)
if ! printf '2.24.0\n%s\n' "${v#v}" | sort -V -C; then
  echo "docker compose $v is older than 2.24 (needed for ports: !reset)" >&2
  exit 1
fi

cp "$H/paperless/docker-compose.postgres.yml" "$H/paperless/docker-compose.env" "$WORK/compose/"
dc config -q

{
  echo "date: $(date -u +%FT%TZ)"
  echo "kernel: $(uname -srm)"
  echo "host glibc: $(ldd --version 2>&1 | head -1)"
  echo "cpus: $(nproc)"
  echo "mem: $(free -g | awk '/^Mem:/ {print $2 " GB"}')"
  echo "docker: $(docker version -f '{{.Server.Version}}')"
  echo "compose: $v"
  echo "loadavg: $(loadavg)"
} > "$RES/env/host.txt"

docker image ls --format '{{.Repository}}:{{.Tag}}@{{.ID}}' | sort > "$RES/env/images-before.txt"
log "pulling images"
dc pull -q
docker image ls --format '{{.Repository}}:{{.Tag}}@{{.ID}}' | sort > "$RES/env/images-after.txt"
comm -13 "$RES/env/images-before.txt" "$RES/env/images-after.txt" > "$RES/env/images-pulled.txt"
for img in $(dc config --images); do
  printf '%s %s\n' "$img" "$(docker image inspect -f '{{join .RepoDigests " "}}' "$img")"
done > "$RES/env/image-digests.txt"
log "pulled: $(tr '\n' ' ' < "$RES/env/images-pulled.txt")"

log "checking the image's exporter matches $PAPERLESS_TAG"
got=$(docker run --rm --entrypoint sha256sum "$PAPERLESS_IMAGE" \
  "$SRC/documents/management/commands/document_exporter.py" | cut -d' ' -f1)
if [[ "$got" != "$EXPORTER_ORIG_SHA256" ]]; then
  echo "image exporter sha256 $got != $EXPORTER_ORIG_SHA256 (patch was made against $PAPERLESS_TAG)" >&2
  exit 1
fi
docker run --rm --entrypoint bash "$PAPERLESS_IMAGE" -c '
  echo "python: $(python3 -c "import sys, sysconfig; print(sys.version.split()[0], sysconfig.get_config_var(\"SOABI\"), sys.abiflags or \"-\")")"
  echo "glibc: $(ldd --version | head -1)"
  echo "os: $(. /etc/os-release; echo $PRETTY_NAME)"
  cd /usr/src/paperless/src && echo "paperless: $(python3 -c "from paperless.version import __full_version_str__ as v; print(v)")"
  echo "django: $(python3 -c "import django; print(django.__version__)")"
  echo "psycopg: $(python3 -c "import psycopg; print(psycopg.__version__)")"
' > "$RES/env/container.txt"
echo "exporter (pristine) sha256: $got" >> "$RES/env/container.txt"
echo "exporter (patched) sha256: $(sha256sum "$H/paperless/document_exporter.py" | cut -d' ' -f1)" >> "$RES/env/container.txt"
cat "$RES/env/container.txt"

log "fetching packmem 0.2.0 from PyPI"
curl -fsSL -o "$WORK/wheels/$PACKMEM_020_WHEEL" "$PACKMEM_020_URL"
echo "$PACKMEM_020_SHA256  $WORK/wheels/$PACKMEM_020_WHEEL" | sha256sum -c -
rm -rf "$WORK/pm/0.2.0"
python3 -m zipfile -e "$WORK/wheels/$PACKMEM_020_WHEEL" "$WORK/pm/0.2.0"
echo "packmem 0.2.0: $PACKMEM_020_WHEEL sha256=$PACKMEM_020_SHA256" > "$RES/env/packmem-0.2.0.txt"

log "starting Paperless"
dc up -d
for i in $(seq 1 120); do
  if dc exec -T webserver curl -fsS -o /dev/null http://localhost:8000/accounts/login/ 2>/dev/null; then
    break
  fi
  sleep 5
done
dc exec -T webserver curl -fsS -o /dev/null http://localhost:8000/accounts/login/
log "Paperless is up"
ensure_time | tee "$RES/env/gnu-time.txt"

log "smoke test of arm B in the container"
in_web env PYTHONPATH=/opt/packmem/0.2.0 python3 /harness/smoke.py "$SRC/documents/management/commands/document_exporter.py" b \
  | tee "$RES/env/smoke-b.txt"
dc ps
log "setup done; next: bash $H/build_main_wheel.sh"
