"""Qwen3-VL-like build phases on a packmem table, with phase markers for an external 2 ms sampler.

usage: phases.py MARKERS.txt JSON [hint]
Writes "<time.time()> <phase> start|end" lines. Mirrors packmem.v3.patch: load_json, set_column("data_path"),
then the lengths and modality_lengths loops of qwen-vl-finetune's LazySupervisedDataset.
"""
import sys, time

import packmem

mk = open(sys.argv[1], "w", buffering=1); path = sys.argv[2]; hint = sys.argv[3] if len(sys.argv) > 3 else "balanced"


def mark(name, what):
    mk.write(f"{time.time():.4f} {name} {what}\n")


time.sleep(0.3)
mark("load_json", "start"); rows = packmem.load_json(path, hint=hint); mark("load_json", "end")
time.sleep(0.3)
mark("set_column", "start"); rows.set_column("data_path", "/data/llava"); mark("set_column", "end")
time.sleep(0.3)
mark("lengths", "start")
L = []
for s in rows:
    L.append(sum(len(c["value"].split()) for c in s["conversations"]) + (128 if "image" in s else 0))
mark("lengths", "end")
time.sleep(0.3)
mark("modality_lengths", "start")
M = []
for s in rows:
    w = sum(len(c["value"].split()) for c in s["conversations"])
    M.append(w if ("image" in s or "video" in s) else -w)
mark("modality_lengths", "end")
time.sleep(0.3)
mark("random_getitem_20k", "start")
import random
r = random.Random(0)
for _ in range(20000): rows[r.randrange(len(rows))]
mark("random_getitem_20k", "end")
time.sleep(0.3)
mark("done", "end")
