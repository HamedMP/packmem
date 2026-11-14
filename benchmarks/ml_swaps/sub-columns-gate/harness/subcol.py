"""Sub-column checks for one packmem build (or the list arm when packmem is not installed).

usage: subcol.py qwen JSON OUT_DIR TAG    lengths/modality_lengths (loop vs column ops), row cost, nbytes,
                                          describe(), decoded-row and to_json() hashes, on Qwen's real 665k file
       subcol.py files OUT_DIR TAG FILE.. nbytes, describe(), decoded-row and to_json() hashes per file
Timings are the median of 3 repeats in this process. lengths are written to OUT_DIR/lengths_<TAG>.json so arms can be
compared value by value.
"""
import hashlib, json, os, random, statistics, sys, time

try:
    import packmem
except ImportError:
    packmem = None


def timed(fn, reps=3):
    ts, out = [], None
    for _ in range(reps):
        t0 = time.perf_counter()
        out = fn()
        ts.append(time.perf_counter() - t0)
    return out, round(statistics.median(ts), 3), [round(t, 3) for t in ts]


def loop_lengths(rows):  # qwenvl/data/data_processor.py LazySupervisedDataset.lengths, verbatim logic
    out = []
    for sample in rows:
        img_tokens = 128 if "image" in sample else 0
        out.append(sum(len(conv["value"].split()) for conv in sample["conversations"]) + img_tokens)
    return out


def loop_modality(rows):  # ... .modality_lengths
    out = []
    for sample in rows:
        cur_len = sum(len(conv["value"].split()) for conv in sample["conversations"])
        out.append(cur_len if ("image" in sample) or ("video" in sample) else -cur_len)
    return out


def notna_or_false(rows, name):
    if name not in rows.columns:
        return [False] * len(rows), f"no '{name}' column"
    return rows.col(name).notna(), None


def col_ops(rows):
    words = rows.col("conversations").list.field("value").str.split().list.len().list.sum()
    has_image, note_i = notna_or_false(rows, "image")
    has_video, note_v = notna_or_false(rows, "video")
    lengths = [w + (128 if i else 0) for w, i in zip(words, has_image)]
    modality = [w if (i or v) else -w for w, i, v in zip(words, has_image, has_video)]
    return lengths, modality, [n for n in (note_i, note_v) if n]


def rows_sha(rows):
    h = hashlib.sha256()
    for r in rows:
        h.update(json.dumps(r, sort_keys=True).encode())
        h.update(b"\n")
    return h.hexdigest()


def describe(t):
    try:
        d = t.describe()
    except Exception as e:
        return f"{type(e).__name__}: {e}"
    return [list(x) if isinstance(x, tuple) else x for x in d]


def qwen(path, out_dir, tag):
    res = {"tag": tag, "packmem": getattr(packmem, "__version__", None)}
    t0 = time.perf_counter()
    if packmem is None:
        rows = json.load(open(path))
    else:
        rows = packmem.load_json(path)
    res["load_s"] = round(time.perf_counter() - t0, 2)
    res["n"] = len(rows)
    lengths, res["loop_lengths_s"], res["loop_lengths_runs"] = timed(lambda: loop_lengths(rows))
    modality, res["loop_modality_s"], res["loop_modality_runs"] = timed(lambda: loop_modality(rows))
    json.dump({"lengths": lengths, "modality": modality}, open(os.path.join(out_dir, f"lengths_{tag}.json"), "w"))
    res["lengths_sha"] = hashlib.sha256(json.dumps([lengths, modality]).encode()).hexdigest()
    if packmem is not None and hasattr(rows, "col"):
        try:
            (cl, cm, notes), res["colops_s"], res["colops_runs"] = timed(lambda: col_ops(rows))
            res["colops_notes"] = notes
            res["colops_lengths_equal_loop"] = cl == lengths
            res["colops_modality_equal_loop"] = cm == modality
            res["colops_lengths_sha"] = hashlib.sha256(json.dumps([cl, cm]).encode()).hexdigest()
            diff = [i for i, (a, b) in enumerate(zip(cl, lengths)) if a != b]
            res["colops_mismatches"] = len(diff)
            res["colops_mismatch_examples"] = [{"i": i, "loop": lengths[i], "colops": cl[i],
                                                "values": [c["value"] for c in rows[i]["conversations"]][:4]} for i in diff[:5]]
            _, res["colops_words_only_s"], _ = timed(lambda: rows.col("conversations").list.field("value").str.split().list.len().list.sum())
        except Exception as e:
            res["colops_error"] = f"{type(e).__name__}: {e}"
    n = len(rows)
    idx = random.Random(2).sample(range(n), 100_000)
    _, res["random_100k_rows_s"], res["random_100k_runs"] = timed(lambda: [rows[i] for i in idx])
    _, res["full_pass_s"], res["full_pass_runs"] = timed(lambda: sum(1 for _ in rows))
    res["rows_sha"] = rows_sha(rows)
    if packmem is not None:
        res["nbytes"] = rows.nbytes
        res["describe"] = describe(rows)
        out = rows.to_json()
        res["to_json_sha"] = hashlib.sha256(out).hexdigest()
        res["to_json_bytes"] = len(out)
        res["to_json_equals_source_decoded"] = json.loads(out) == json.load(open(path)) if os.environ.get("ROUNDTRIP") == "1" else None
    json.dump(res, open(os.path.join(out_dir, f"qwen_{tag}.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != "describe"}))


def files(out_dir, tag, paths):
    res = {"tag": tag, "packmem": packmem.__version__, "files": {}}
    for p in paths:
        t0 = time.perf_counter()
        t = packmem.load_jsonl(p) if p.endswith(".jsonl") else packmem.load_json(p)
        load_s = time.perf_counter() - t0
        out = t.to_json()
        res["files"][os.path.basename(p)] = {"n": len(t), "load_s": round(load_s, 2), "nbytes": t.nbytes,
                                             "rows_sha": rows_sha(t), "to_json_sha": hashlib.sha256(out).hexdigest(),
                                             "to_json_bytes": len(out), "describe": describe(t)}
        del t, out
    json.dump(res, open(os.path.join(out_dir, f"files_{tag}.json"), "w"), indent=1)
    print(json.dumps({f: {k: v for k, v in x.items() if k != "describe"} for f, x in res["files"].items()}))


if __name__ == "__main__":
    if sys.argv[1] == "qwen":
        qwen(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        files(sys.argv[2], sys.argv[3], sys.argv[4:])
