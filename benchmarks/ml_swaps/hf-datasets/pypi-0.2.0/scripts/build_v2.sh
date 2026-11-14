set -eux
cd ~/packmem-hfbench
export RUSTUP_HOME=$PWD/rust/rustup CARGO_HOME=$PWD/rust/cargo PIP_CACHE_DIR=$PWD/pipcache
curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs -o rust-init.sh
sh rust-init.sh -y --no-modify-path --profile minimal
export PATH=$CARGO_HOME/bin:$PATH
rustc --version; cargo --version
git clone -q --branch wip/zero-copy-v2 https://github.com/<user>/packmem src-v2
git -C src-v2 rev-parse HEAD
git -C src-v2 log --oneline -3
python3 -m venv venv2
venv2/bin/pip install -q -U pip
venv2/bin/pip install -q maturin
cd src-v2/python
CARGO_TARGET_DIR=$HOME/packmem-hfbench/rust/target ../../venv2/bin/maturin build --release -o dist
ls -la dist
sha256sum dist/*.whl
echo BUILD_DONE
