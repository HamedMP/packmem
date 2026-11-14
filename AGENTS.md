# AGENTS.md

Notes for coding agents working on this repository. To use packmem in another project, read
https://hamedmp.github.io/packmem/llms-full.txt or copy `skills/packmem/SKILL.md` instead.

## What this is

packmem stores record collections as packed, queryable columns. A Rust core with three bindings that share it:

| Path | Contents |
| --- | --- |
| `src/` | Rust core. `dynamic.rs` is the record table behind every binding (`DynTable`); `ints.rs` and `strs.rs` the encodings; `wire.rs` the byte reader and writer; `ztext.rs` Zstandard text for `Hint::Compact` |
| `python/` | Python package (PyO3, built with maturin): `src/lib.rs` binds `DynTable`, `py/packmem/__init__.py` is the public API; tests in `python/tests/` |
| `node/` | npm package: native addon (`src/`, napi-rs), WebAssembly build (`wasm/`), shared JS API (`api.js`), entry points `index.js`, `wasm.js`, `http.js`, `react.js` with `.d.ts` files; tests in `node/test/` |
| `demos/` | Express, Next.js, FastAPI, Cloudflare Workers and a fine-tuning loader, each comparing packmem with plain containers |
| `benchmarks/`, `experiments/` | Benchmarks and their recorded results |
| `site/` | The website and docs (Next.js static export to GitHub Pages); docs pages are Markdown in `site/content/docs/` |
| `skills/packmem/` | The skill file users give their coding agents |

## Build and test

```sh
cargo test --features ztext                     # Rust core; also run with --release
cargo fmt --check && cargo clippy --release --all-targets

cd python && maturin build --release -o dist && pip install --force-reinstall dist/*.whl
python -m pytest python/tests                   # needs pytest and hypothesis; also with PACKMEM_THREADS=1

cd node && npm ci && npm run build && npm run build:wasm   # wasm needs wasm32-unknown-unknown and wasm-bindgen-cli
npm test                                        # node --test; set PACKMEM_PYTHON to cross-check Python bytes
npm run test:browser                            # headless Chromium via playwright-core

cd site && pnpm install && pnpm build           # static site in site/out
```

The Node addon and the Python wheel must be rebuilt after any change in `src/`.

## Rules

- **Behave like the container it replaces.** New behaviour needs a test that compares packmem with a plain list of
  dicts, array of objects or Rust container.
- **Byte format.** Anything that changes what `to_bytes` / `toBytes` / `save` write must raise `FORMAT` in
  `src/dynamic.rs`, keep reading the older formats, and keep `python/tests/fixtures/` readable. An older reader
  must refuse newer bytes with "written by a newer packmem", never misread them.
- **Numbers need raw files.** Any figure in a README, the site, the changelog or a post must come from a results
  file committed in the repository, with the machine and load average recorded. Run benchmarks on a quiet machine,
  serially, in fresh processes. Report regressions as well as gains.
- **Changelog.** Add a line under `## Unreleased` in `CHANGELOG.md` for every user-visible change.
- **Releases** are cut by pushing a `v*` tag, which publishes to PyPI, npm and crates.io. Do not tag without the
  maintainer's approval.
- **Commits.** Short messages that say why. Stage explicit paths.
- **Docs.** The site's docs and `skills/packmem/SKILL.md` describe the released API; check every snippet against
  the `.d.ts` files and `python/py/packmem/__init__.py`.
