"""Stream LLaVA-1.5 mix665k (JSON array) into the ShareGPT layout NeMo Automodel's
make_meta_dataset reads: `image` (a single path string) becomes `images: [path]`,
everything else is kept. Writes OUT.json (array) and a meta JSON next to it.

The meta file uses the column/tag mapping of
nemo_automodel/components/speculative/regenerate_vlm.py (SHAREGPT_COLUMNS/TAGS).

usage: convert.py SRC.json OUT.json [--n N] [--stride K] [--media-dir DIR]
Memory stays low: records are decoded one at a time with raw_decode.
"""
import argparse
import json
import os

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("out")
ap.add_argument("--n", type=int, default=None)
ap.add_argument("--stride", type=int, default=1, help="keep every STRIDE-th record (a spread-out subset)")
ap.add_argument("--media-dir", default="/data/llava")
args = ap.parse_args()


def iter_array(path, chunk=1 << 22):
    dec = json.JSONDecoder()
    with open(path, encoding="utf-8") as f:
        buf = f.read(chunk)
        pos = buf.index("[") + 1
        while True:
            while True:
                while pos < len(buf) and buf[pos] in " \t\r\n,":
                    pos += 1
                if pos < len(buf) and buf[pos] == "]":
                    return
                try:
                    obj, end = dec.raw_decode(buf, pos)
                    break
                except json.JSONDecodeError:
                    more = f.read(chunk)
                    if not more:
                        raise
                    buf = buf[pos:] + more
                    pos = 0
            yield obj
            pos = end
            if pos > chunk:
                buf, pos = buf[pos:], 0


def convert(r):
    out = {}
    for k, v in r.items():
        if k == "image":
            out["images"] = [v]
        else:
            out[k] = v
    return out


n = 0
with open(args.out, "w", encoding="utf-8") as f:
    f.write("[")
    for i, rec in enumerate(iter_array(args.src)):
        if i % args.stride:
            continue
        if args.n is not None and n >= args.n:
            break
        f.write(("," if n else "") + "\n" + json.dumps(convert(rec)))
        n += 1
    f.write("\n]\n")

meta = {
    "llava_v1_5_mix665k": {
        "file_name": os.path.basename(args.out),
        "columns": {"messages": "conversations", "images": "images"},
        "tags": {"role_tag": "from", "content_tag": "value", "user_tag": "human", "assistant_tag": "gpt"},
        "media_dir": args.media_dir,
    }
}
meta_path = os.path.splitext(args.out)[0] + ".meta.json"
with open(meta_path, "w") as f:
    json.dump(meta, f, indent=2)
print(json.dumps({"records": n, "out": args.out, "meta": meta_path}))
