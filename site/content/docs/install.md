# Install

The current release is {{VERSION}}. Install the same version on every side that exchanges packed bytes (see
[Byte format](/docs/format/)).

## Python

```sh
pip install packmem
```

Python 3.10 or later. Wheels for Linux (x86-64 and arm64, glibc and musl), macOS and Windows. `to_arrow`,
`from_arrow`, `read_parquet` and `to_parquet` need `pyarrow` installed.

## Node, Bun and Deno

```sh
npm install packmem
```

Node 20 or later. The package ships prebuilt native addons for Linux x86-64 and arm64 (glibc 2.17 or later, and
musl), macOS on Apple silicon and Intel, and Windows x64. On other platforms, build from source with Rust
(`npm run build` in the package).

- Bun: `bun add packmem`.
- Deno: `import { from } from "npm:packmem"`, run with `--allow-ffi` (or `-A`).

The package is an ES module. CommonJS code can `require` it on Node 22.12 or later.

## Browsers and edge runtimes

The same npm package includes `packmem/wasm`, the library compiled to WebAssembly, for runtimes that cannot load a
native addon: browsers, Cloudflare Workers, Deno without FFI. See [Browsers and edge](/docs/browser/).

| Import | What it is |
| --- | --- |
| `packmem` | The native addon for Node, Bun and Deno |
| `packmem/wasm` | The same API on WebAssembly (no file paths or Node streams) |
| `packmem/wasm/packmem.wasm` | The WebAssembly binary, for bundlers and Workers |
| `packmem/http` | Send and fetch tables over HTTP; no Node imports |
| `packmem/react` | `useTable` and `useRows` for React components |

## Rust

```sh
cargo add packmem --no-default-features
```

The default `baselines` feature only exists for the repository's benchmarks and pulls in C dependencies.

## From a checkout

```sh
# Python wheel
cd python && pip install maturin && maturin build --release -o dist && pip install dist/*.whl

# Node addon and WebAssembly build
cd node && npm run build && npm run build:wasm
```
