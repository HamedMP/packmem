set -eux
cd ~/packmem-hfbench
export PIP_CACHE_DIR=$PWD/pipcache HF_HOME=$PWD/hf HF_HUB_DISABLE_TELEMETRY=1
python3 -m venv venv
venv/bin/pip install -q -U pip
venv/bin/pip download -q --no-deps packmem==0.1.1 -d out2/wheels
sha256sum out2/wheels/*
venv/bin/pip install -q out2/wheels/packmem-0.1.1-*.whl datasets pyarrow psutil numpy
venv/bin/pip install -q torch --index-url https://download.pytorch.org/whl/cpu
venv/bin/pip freeze
venv/bin/python -c "from huggingface_hub import hf_hub_download; print(hf_hub_download(\"liuhaotian/LLaVA-Instruct-150K\", \"llava_v1_5_mix665k.json\", repo_type=\"dataset\", local_dir=\"data\"))"
sha256sum data/llava_v1_5_mix665k.json
echo SETUP_DONE
