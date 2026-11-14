#!/usr/bin/env bash
# Stop and remove the stack, its volumes and the images setup.sh pulled, and
# delete everything in $WORK except harness/ and results/. Run after collect.sh.
source "$(dirname "$0")/env.sh"

log "removing containers and volumes of $PROJECT"
dc down -v --remove-orphans

if [[ -s "$RES/env/images-pulled.txt" ]]; then
  while read -r ref; do
    id=${ref##*@}
    log "removing image $ref"
    docker image rm "$id" || docker image rm -f "$id" || true
  done < "$RES/env/images-pulled.txt"
fi

rm -rf "$WORK/rust" "$WORK/src" "$WORK/wheels" "$WORK/pm" "$WORK/compose" "$WORK/.secret_key"

echo "left in $WORK:"; ls -la "$WORK"
echo "containers: $(docker ps -aq --filter label=com.docker.compose.project=$PROJECT | wc -l)"
echo "volumes:    $(docker volume ls -q --filter label=com.docker.compose.project=$PROJECT | wc -l)"
echo "images still present from the pulled list:"
while read -r ref; do docker image inspect "${ref##*@}" >/dev/null 2>&1 && echo "  $ref"; done < "$RES/env/images-pulled.txt" || true
du -sh "$WORK"
