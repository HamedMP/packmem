#!/usr/bin/env bash
# Run on the Mac: copy the harness and a packmem source archive of the pinned
# commit to the server. Nothing heavy runs locally.
set -euo pipefail
HOST=${HOST:-bench-server}
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=${PACKMEM_REPO:-$PWD}
COMMIT=$(sed -n 's/^PACKMEM_MAIN_COMMIT=//p' "$HERE/env.sh")
short=${COMMIT:0:7}
out="$HERE/../dist"
mkdir -p "$out"

git -C "$REPO" cat-file -e "$COMMIT^{commit}"
git -C "$REPO" archive --format=tar.gz --prefix="packmem-$short/" -o "$out/packmem-$short.tar.gz" \
  "$COMMIT" Cargo.toml Cargo.lock README.md LICENSE NOTICE src python
echo "$COMMIT" > "$out/packmem-$short.commit"
(cd "$out" && shasum -a 256 "packmem-$short.tar.gz" > "packmem-$short.tar.gz.sha256")
cat "$out/packmem-$short.tar.gz.sha256"

ssh "$HOST" 'mkdir -p ~/packmem-paperless/src ~/packmem-paperless/harness'
rsync -a --delete --exclude '__pycache__' "$HERE/" "$HOST:packmem-paperless/harness/"
rsync -a "$out/packmem-$short.tar.gz" "$out/packmem-$short.commit" "$out/packmem-$short.tar.gz.sha256" \
  "$HOST:packmem-paperless/src/"
ssh "$HOST" 'cd ~/packmem-paperless && chmod +x harness/*.sh && ls -la harness src'
