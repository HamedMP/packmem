set -eux
cd ~/packmem-hfbench
export PIP_CACHE_DIR=$PWD/pipcache HF_HOME=$PWD/hf HF_HUB_DISABLE_TELEMETRY=1
python3 -m venv venv020
venv020/bin/pip install -q -U pip
venv020/bin/pip download -q --no-deps --only-binary=:all: packmem==0.2.0 -d out-0.2.0/wheels
sha256sum out-0.2.0/wheels/*
venv020/bin/pip install -q out-0.2.0/wheels/packmem-0.2.0-*.whl datasets pyarrow psutil numpy
venv020/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cpu
venv020/bin/pip freeze
venv020/bin/python -I -c "import packmem; print(packmem.__file__, packmem.__version__)"
venv020/bin/python -c "from huggingface_hub import hf_hub_download; print(hf_hub_download(\"liuhaotian/LLaVA-Instruct-150K\", \"llava_v1_5_mix665k.json\", repo_type=\"dataset\", local_dir=\"data\"))"
sha256sum data/llava_v1_5_mix665k.json
echo SETUP4_DONE
