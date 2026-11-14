set -eux
cd ~/packmem-hfbench
export RUSTUP_HOME=$PWD/rust/rustup CARGO_HOME=$PWD/rust/cargo PIP_CACHE_DIR=$PWD/pipcache HF_HOME=$PWD/hf HF_HUB_DISABLE_TELEMETRY=1
curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs -o rust-init.sh
sh rust-init.sh -y --no-modify-path --profile minimal
export PATH=$CARGO_HOME/bin:$PATH
rustc --version; cargo --version
git clone -q --branch wip/zero-copy-v2 https://github.com/<user>/packmem src-v2b
git -C src-v2b checkout -q 7de0b9396b44cd253aeb22d33248a6fe8c1b01e4
git -C src-v2b rev-parse HEAD
git -C src-v2b log --oneline -4
python3 -m venv venv2b
venv2b/bin/pip install -q -U pip
venv2b/bin/pip install -q maturin
cd src-v2b/python
CARGO_TARGET_DIR=$HOME/packmem-hfbench/rust/target ../../venv2b/bin/maturin build --release -o dist
ls -la dist
sha256sum dist/*.whl
cd ~/packmem-hfbench
venv2b/bin/pip install -q src-v2b/python/dist/*.whl datasets pyarrow psutil numpy pytest hypothesis
venv2b/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cpu
venv2b/bin/pip freeze
venv2b/bin/python -I -c "import packmem; print(packmem.__file__, packmem.__version__)"
venv2b/bin/python -c "from huggingface_hub import hf_hub_download; print(hf_hub_download(\"liuhaotian/LLaVA-Instruct-150K\", \"llava_v1_5_mix665k.json\", repo_type=\"dataset\", local_dir=\"data\"))"
sha256sum data/llava_v1_5_mix665k.json
echo SETUP3_DONE
