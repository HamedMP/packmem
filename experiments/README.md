# Synthetic-log study

The experiments behind the first half of [the report](../docs/report.md): one synthetic
web-access log held in several runtimes and in packmem.

```
python3 gen.py 300000 logs.jsonl          # deterministic generator (seed 42)
python3 gen.py 2000000 logs2m.jsonl
cargo build --release
../target/release/bench logs2m.jsonl      # memory and 8 queries across 7 representations; needs about 4 GB
../target/release/selector                # selector against exhaustive search; cost per operation by encoding
./run.sh python-logs python3 w_py.py logs.jsonl   # heap composition of a live process (Linux, root)
```

`w_*` and `W.java` load the log in Python, Node, Ruby and Java; `q.py` and `q.js` time three
queries there. `analyze.py` classifies a process's resident memory word by word and is
Linux-only. Recorded outputs are in `results/`.
