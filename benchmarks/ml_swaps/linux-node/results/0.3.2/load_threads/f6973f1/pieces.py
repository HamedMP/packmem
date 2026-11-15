import json, sys
rows = json.load(open(sys.argv[1]))
out = []
for i in range(0, len(rows), 16384):
    out.append(sum(len(json.dumps(r)) for r in rows[i:i+16384]))
json.dump({"records": len(rows), "piece_records": 16384, "piece_bytes": out}, open("piece_bytes.json", "w"))
print(len(out), "pieces; MB:", " ".join(f"{b/1e6:.0f}" for b in out))
