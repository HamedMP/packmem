# Contributing to packmem

Thanks for your interest. packmem is alpha software; bug reports with a small reproducing input
are the most useful contribution right now.

## Building and testing

You need a stable Rust toolchain and Python 3.10 or later.

```
cargo test --release                                  # Rust core
cd python
maturin build --release -o dist && pip install --force-reinstall dist/*.whl
python tests/test_packmem.py                          # model test against a list of dicts
python tests/test_paths.py                            # fast paths, JSON parsing, lazy rows, list methods
pip install hypothesis && python tests/test_properties.py   # property-based round trips and edits
```

Before sending a change, run `cargo fmt` in the repository root and in `python/`, and check that
`cargo clippy --release --all-targets` reports nothing new.

## What a change needs

- **Correctness first.** A table must behave like the list of dicts it replaces. New behaviour
  needs a test that compares packmem against plain Python or plain Rust containers.
- **Numbers for performance claims.** Say what you measured, on what machine, and include the
  before and after. `benchmarks/run_all.py` runs every variant in fresh processes.
- **Report regressions too.** If a change makes one case faster and another slower, say so in
  the pull request.

## Benchmark results

Files under `benchmarks/results/` and `experiments/results/` are recorded outputs. Add a new
folder for a new machine rather than overwriting an existing one, and keep the machine line that
`run_all.py` writes.

## Commit messages

Keep them short and say why the change was made.

## License

By contributing you agree that your contribution is dual licensed under MIT and Apache-2.0, as
described in the README.
