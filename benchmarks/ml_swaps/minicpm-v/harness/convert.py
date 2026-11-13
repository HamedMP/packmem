import json, sys, zlib
src, dst = sys.argv[1], sys.argv[2]
data = json.load(open(src))
role = {"human": "user", "gpt": "assistant"}
out = []
stats = {"str": 0, "dict": 0, "none": 0}
for r in data:
    conv = [{"role": role[m["from"]], "content": m["value"]} for m in r["conversations"]]
    rec = {"id": r["id"]}
    if "image" in r:
        if zlib.crc32(str(r["id"]).encode()) % 50 == 0:
            conv[0]["content"] = conv[0]["content"].replace("<image>", "<image_00>")
            rec["image"] = {"<image_00>": r["image"]}
            stats["dict"] += 1
        else:
            rec["image"] = r["image"]
            stats["str"] += 1
    else:
        stats["none"] += 1
    rec["conversations"] = conv
    out.append(rec)
json.dump(out, open(dst, "w"), indent=2)
print(len(out), stats)
