"""One fresh process per call: bench_load.py ARM MODE [CACHE_DIR]

ARM: A (list) | B1 (HF mmap) | B2 (HF keep_in_memory) | B3 (HF from parquet) | B4 (HF, conversations as Json) | C (packmem)
MODE: conv (first-time HF conversion) | full (load + access + memory) | size | hash | mkparquet
"""
import gc
import hashlib
import json
import os
import pickle
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

perf = C.perf


def timed(fn):
    t0 = perf()
    fn()
    return perf() - t0


def access(x, arm, out):
    n = len(x)
    rng = random.Random(1)
    idx100k = [rng.randrange(n) for _ in range(100_000)]
    rng = random.Random(2)
    idx20k = [rng.randrange(n) for _ in range(20_000)]
    rng = random.Random(3)
    starts = [rng.randrange(n - 64) for _ in range(2_000)]

    def rand_dict():
        for i in idx100k:
            d = x[i]
        return d

    def rand_conv():
        for i in idx20k:
            c = x[i]["conversations"]
        return c

    def slices():
        for s in starts:
            b = x[s:s + 64]
        return b

    def seq():
        for r in x:
            v = r["conversations"][0]["value"]
        return v

    out["rand100k_dict_s"] = timed(rand_dict)
    out["rand20k_conv_s"] = timed(rand_conv)
    out["slice64_x2000_s"] = timed(slices)
    if arm == "C":
        t = x._t
        out["lazy_rand100k_s"] = timed(lambda: [t.rows_lazy(i, i + 1) for i in idx100k] and None)
        out["lazy_rand20k_conv_s"] = timed(lambda: [t.rows_lazy(i, i + 1)[0]["conversations"] for i in idx20k] and None)
    gc.collect()
    out["mem_after_random"] = C.mem()
    out["seq_pass_s"] = timed(seq)
    if arm == "C":
        def lazy_seq():
            for r in x.lazy():
                v = r["conversations"][0]["value"]
            return v
        out["lazy_seq_pass_s"] = timed(lazy_seq)
    if arm.startswith("B"):
        def iter_batched():
            for b in x.iter(batch_size=1000):
                v = [c[0]["value"] for c in b["conversations"]]
            return v
        out["hf_iter_batch1000_pass_s"] = timed(iter_batched)
    gc.collect()
    out["mem_after_pass"] = C.mem()


def pickled(x, out):
    from multiprocessing.reduction import ForkingPickler

    t0 = perf()
    b = ForkingPickler.dumps(x)
    out["pickle_dumps_s"] = perf() - t0
    out["pickle_bytes"] = len(b)
    t0 = perf()
    y = pickle.loads(b)  # bytes produced by this process a line above
    out["pickle_loads_s"] = perf() - t0
    del y, b


def main():
    arm, mode = sys.argv[1], sys.argv[2]
    cache = sys.argv[3] if len(sys.argv) > 3 else None
    out = {"arm": arm, "mode": mode, "cache": cache, "mem_start": C.mem()}

    if mode == "size" and arm == "A":
        import tracemalloc

        tracemalloc.start()
        gc.collect()
        b0 = tracemalloc.get_traced_memory()[0]
        with open(C.DATA, "rb") as f:
            rows = json.load(f)
        gc.collect()
        out["tracemalloc_after_load"] = tracemalloc.get_traced_memory()[0] - b0
        for r in rows:
            r["id"] = str(r["id"])
        gc.collect()
        out["tracemalloc_after_norm"] = tracemalloc.get_traced_memory()[0] - b0
        tracemalloc.stop()
        out["mem_after_load"] = C.mem()
        print(json.dumps(out))
        return

    x, t_load, t_norm = C.load(arm, cache)
    out["load_s"], out["norm_s"], out["n"] = t_load, t_norm, len(x)
    gc.collect()
    out["mem_after_load"] = C.mem()

    if arm.startswith("B"):
        out["arrow_files"] = C.arrow_files(cache)
        out["arrow_bytes"] = sum(out["arrow_files"].values())
        out["table_nbytes"] = x.data.nbytes
        out["features"] = str(x.features)
        out["cache_files"] = [c["filename"] for c in x.cache_files]
        out["first_ids"] = x[:5]["id"]
    if arm == "C":
        out["nbytes"] = x.nbytes
        out["describe"] = [list(map(str, d)) for d in x.describe()]
        out["first_ids"] = [x[i]["id"] for i in range(5)]
    if arm == "A":
        out["first_ids"] = [x[i]["id"] for i in range(5)]

    if mode == "mkparquet":
        import pyarrow.parquet as pq

        # datasets' to_parquet pins snappy per column, so zstd goes through pyarrow with the HF schema metadata kept
        t0 = perf()
        pq.write_table(x.data.table, C.PARQUET, compression="zstd")
        out["parquet_write_s"] = perf() - t0
        out["parquet_bytes"] = os.path.getsize(C.PARQUET)
        snappy = C.PARQUET.replace(".zstd.", ".hfsnappy.")
        t0 = perf()
        x.to_parquet(snappy)
        out["hf_to_parquet_snappy_s"] = perf() - t0
        out["hf_to_parquet_snappy_bytes"] = os.path.getsize(snappy)
        os.remove(snappy)
    elif mode == "full":
        access(x, arm, out)
        if arm != "B2":
            pickled(x, out)
        gc.collect()
        out["mem_end"] = C.mem()
    elif mode == "size":
        pickled(x, out)
    elif mode == "hash":
        canon, raw = bytearray(), bytearray()
        t0 = perf()
        first_text = None
        for k, r in enumerate(x):
            if first_text is None and r.get("model") is not None:
                first_text = k
            canon += C.record_hash(C.strip_none(r))
            if arm in ("A", "C"):
                raw += C.record_hash(r)
        out["hash_s"] = perf() - t0
        with open(f"{C.OUT}/hash_{arm}_canon.bin", "wb") as f:
            f.write(canon)
        out["canon_digest"] = hashlib.sha256(canon).hexdigest()
        if raw:
            with open(f"{C.OUT}/hash_{arm}_raw.bin", "wb") as f:
                f.write(raw)
            out["raw_digest"] = hashlib.sha256(raw).hexdigest()
        out["sample_650962"] = C.strip_none(x[650962])["conversations"][1] if arm != "A" else x[650962]["conversations"][1]
        out["first_text_only_idx"] = first_text
        out["sample_text_only"] = {k: v for k, v in x[first_text].items() if k != "conversations"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
