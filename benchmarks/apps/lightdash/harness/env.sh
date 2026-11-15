# Pins and paths shared by every script. Source it: `. harness/env.sh`.
export LD_VERSION=3.261.1
export LD_COMMIT=7d257bd93b7f312c5a63732c82956d870546da4a
export LD_IMAGE=lightdash/lightdash:3.261.1@sha256:047a0512ca611b1d8c470a8889a84e9fda60a060023f098bb8c0b3156f6918be
export PG_IMAGE=postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929
export MINIO_IMAGE=coollabsio/minio@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9
export NGINX_IMAGE=nginx:1.29.3-alpine@sha256:b3c656d55d7ad751196f21b7fd2e8d4da9cb430e32f646adcf92441b72f82b14
export PACKMEM_VERSION=0.3.2
export TYPESCRIPT_VERSION=5.9.3
export PLAYWRIGHT_VERSION=1.56.1
export ESBUILD_VERSION=0.25.11

# Work tree outside this repository: the Lightdash clone, the built stage, tools and raw output.
export LDB_ROOT=${LDB_ROOT:-$HOME/packmem-lightdash}
export LDB_HARNESS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export LDB_STAGE=$LDB_ROOT/stage
export LDB_TOOLS=$LDB_ROOT/tools
export COMPOSE_PROJECT_NAME=packmem-lightdash
export LDB_PORT=${LDB_PORT:-8180}
export LDB_URL=http://127.0.0.1:$LDB_PORT
export PRODUCT_EVENTS_ROWS=${PRODUCT_EVENTS_ROWS:-100000}
