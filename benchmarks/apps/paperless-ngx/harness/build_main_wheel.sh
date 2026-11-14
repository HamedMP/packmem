#!/usr/bin/env bash
# Build the packmem main wheel from the pushed source archive, with a Rust
# toolchain and maturin kept inside $WORK. Run on the server after setup.sh.
source "$(dirname "$0")/env.sh"

short=${PACKMEM_MAIN_COMMIT:0:7}
archive="$WORK/src/packmem-$short.tar.gz"
export RUSTUP_HOME="$WORK/rust/rustup" CARGO_HOME="$WORK/rust/cargo"
export PATH="$CARGO_HOME/bin:$PATH" CARGO_BUILD_JOBS=8
mkdir -p "$WORK/rust" "$WORK/wheels" "$WORK/pm"

( cd "$WORK/src" && sha256sum -c "packmem-$short.tar.gz.sha256" )
if [[ "$(cat "$WORK/src/packmem-$short.commit")" != "$PACKMEM_MAIN_COMMIT" ]]; then
  echo "archive is from $(cat "$WORK/src/packmem-$short.commit"), expected $PACKMEM_MAIN_COMMIT" >&2
  exit 1
fi

if [[ ! -x "$CARGO_HOME/bin/cargo" ]]; then
  log "installing a Rust toolchain into $WORK/rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y -q --no-modify-path --profile minimal --default-toolchain stable
fi
rustc --version

maturin="$WORK/rust/maturin/maturin"
if [[ ! -x "$maturin" ]]; then
  log "fetching maturin $MATURIN_VERSION"
  url=$(curl -fsSL "https://pypi.org/pypi/maturin/$MATURIN_VERSION/json" | python3 -c '
import json, sys
files = json.load(sys.stdin)["urls"]
print(next(f["url"] for f in files if "manylinux" in f["filename"] and f["filename"].endswith("x86_64.whl")))')
  rm -rf "$WORK/rust/maturin" && mkdir -p "$WORK/rust/maturin"
  curl -fsSL -o "$WORK/rust/maturin/maturin.whl" "$url"
  python3 -m zipfile -e "$WORK/rust/maturin/maturin.whl" "$WORK/rust/maturin/whl"
  install -m 755 "$WORK/rust/maturin/whl/maturin-$MATURIN_VERSION.data/scripts/maturin" "$maturin"
fi
"$maturin" --version

src="$WORK/src/packmem-$short"
rm -rf "$src" && mkdir -p "$src"
tar xzf "$archive" -C "$src" --strip-components=1
rm -f "$WORK"/wheels/packmem-0.3*.whl

log "building packmem $short (release)"
cd "$src/python"
build=("$maturin" build --release --out "$WORK/wheels")
if systemd-run --user --scope -q true 2>/dev/null; then
  systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 nice -n 10 "${build[@]}"
else
  nice -n 10 "${build[@]}"
fi

wheel=$(ls "$WORK"/wheels/packmem-0.3*.whl)
sha=$(sha256sum "$wheel" | cut -d' ' -f1)
rm -rf "$WORK/pm/main"
python3 -m zipfile -e "$wheel" "$WORK/pm/main"
{
  echo "packmem main: commit $PACKMEM_MAIN_COMMIT"
  echo "wheel: $(basename "$wheel") sha256=$sha"
  echo "rustc: $(rustc --version)"
  echo "maturin: $("$maturin" --version)"
} | tee "$RES/env/packmem-main.txt"

if dc ps --status running -q webserver | grep -q .; then
  log "smoke test of arms C and D in the container"
  in_web env PYTHONPATH=/opt/packmem/main python3 /harness/smoke.py "$SRC/documents/management/commands/document_exporter.py" c d \
    | tee "$RES/env/smoke-cd.txt"
  in_web env PYTHONPATH=/opt/packmem/main python3 -c 'import packmem; print("container imports packmem", packmem.__version__, packmem.__file__)' \
    | tee -a "$RES/env/packmem-main.txt"
fi
