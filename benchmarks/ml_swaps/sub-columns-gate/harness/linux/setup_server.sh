#!/bin/bash
# Run on the Linux server. Everything lives in $D; nothing else in $HOME is touched.
# usage: setup_server.sh   (expects the harness already copied to $D/harness/{v3,llava-v2,llava-root})
set -eu
D=$HOME/packmem-subcol
export RUSTUP_HOME=$D/rust/rustup CARGO_HOME=$D/rust/cargo
LOG=$D/setup.log
cd $D
log() { echo "$(date '+%F %T') $*" | tee -a $LOG; }

# toolchain and wheels
if [ ! -x $CARGO_HOME/bin/cargo ]; then
  curl -sSf https://sh.rustup.rs -o $D/rustup-init.sh
  sh $D/rustup-init.sh -y --no-modify-path --profile minimal -q
  rm $D/rustup-init.sh
fi
log "rustc $($CARGO_HOME/bin/rustc --version)"
python3 -m venv $D/venv-build && $D/venv-build/bin/pip install -q maturin
[ -d $D/build ] || git clone -q https://github.com/HamedMP/packmem $D/build
cd $D/build && git fetch -q origin
build() {  # build COMMIT OUTDIR
  cd $D/build && git checkout -q "$1"
  (cd python && PATH=$CARGO_HOME/bin:$PATH CARGO_TARGET_DIR=$D/target $D/venv-build/bin/maturin build --release -o "$2" >> $LOG 2>&1)
  log "built $(git rev-parse HEAD) -> $(ls $2) sha256 $(sha256sum $2/*.whl | cut -c1-64)"
}
rm -rf $D/wheels/cand $D/wheels/compact; build ${CAND:-e4508b1} $D/wheels/cand
MAIN=$(git -C $D/build rev-parse origin/main)
build $MAIN $D/wheels/compact
rm -rf $D/target
$D/venv-build/bin/pip download -q packmem==0.2.0 --no-deps --only-binary=:all: -d $D/wheels/020
log "0.2.0 $(ls $D/wheels/020) sha256 $(sha256sum $D/wheels/020/*.whl | cut -c1-64)"

# base venvs (no packmem = the list arms), CPU torch
python3 -m venv $D/venv
$D/venv/bin/pip install -q --index-url https://download.pytorch.org/whl/cpu torch==2.15.0
$D/venv/bin/pip install -q transformers==5.22.2 psutil numpy
python3 -m venv $D/llava-next/venv
$D/llava-next/venv/bin/pip install -q --index-url https://download.pytorch.org/whl/cpu torch==2.15.0
$D/llava-next/venv/bin/pip install -q "transformers==4.49.0" pyyaml pillow numpy packaging requests tokenizers psutil
# thin venvs: only the packmem wheel, everything else from the base venv via a .pth line
PYV=$(python3 -c 'import sys; print(f"python{sys.version_info[0]}.{sys.version_info[1]}")')
thin() {  # thin BASE NAME WHEEL
  python3 -m venv $1-$2 && $1-$2/bin/pip install -q --no-deps $3
  echo "$1/lib/$PYV/site-packages" > $1-$2/lib/$PYV/site-packages/zz_base_venv.pth
}
for base in $D/venv $D/llava-next/venv; do
  thin $base 020 $D/wheels/020/*.whl
  thin $base cand $D/wheels/cand/*.whl
  thin $base compact $D/wheels/compact/*.whl
  thin $base candt $D/wheels/cand/*.whl
  echo 'import os; os.environ.setdefault("PACKMEM_THREADS", "1")' > $base-candt/lib/$PYV/site-packages/sitecustomize.py
done

# trees
mkdir -p $D/src && cd $D/src
[ -d qwen ] || { git init -q qwen && cd qwen && git remote add origin https://github.com/QwenLM/Qwen3-VL.git && git fetch -q --depth 1 origin 96588727e44c78b25ba03ea03b8e12f7e64fd0da && git checkout -q FETCH_HEAD && cd ..; }
for t in orig repo repo-open; do [ -d $D/$t ] || git -C $D/src/qwen worktree add -q --detach $D/$t HEAD; done
git -C $D/repo apply $D/patches/packmem.v3.patch
git -C $D/repo-open apply $D/patches/packmem.v3.patch && patch -s -d $D/repo-open -p1 < $D/patches/open.patch
[ -d llava ] || { git init -q llava && cd llava && git remote add origin https://github.com/LLaVA-VL/LLaVA-NeXT.git && git fetch -q --depth 1 origin bce12e479bc4dfee2b9c50c88137b01ff51bd483 && git checkout -q FETCH_HEAD && cd ..; }
for t in repo-orig repo; do [ -d $D/llava-next/$t ] || git -C $D/src/llava worktree add -q --detach $D/llava-next/$t HEAD; done
git -C $D/llava-next/repo apply $D/patches/llava.packmem.v2.patch
$D/llava-next/venv/bin/pip install -q --no-deps -e $D/llava-next/repo-orig

# data
mkdir -p $D/data && cd $D/data
[ -f llava_v1_5_mix665k.json ] || { curl -sSfL -o x.part "https://huggingface.co/datasets/liuhaotian/LLaVA-Instruct-150K/resolve/main/llava_v1_5_mix665k.json" && mv x.part llava_v1_5_mix665k.json; }
log "data $(sha256sum llava_v1_5_mix665k.json)"
(cd $D/llava-next/harness && $D/llava-next/venv/bin/python -I gen_data.py $D/llava-next/data 1.0)
log "setup done; free: $(free -g | awk '/Mem/{print $7}') GB available; disk: $(du -sh $D | cut -f1)"
