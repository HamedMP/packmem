"""Generate LLaVA-format SFT files shaped like the public LLaVA-1.5 / OneVision mixes.

Records follow the layout LazySupervisedDataset reads:
  {"id": ..., "image": "<subdir>/<file>.jpg", "conversations": [{"from": "human", "value": "<image>\\n..."}, {"from": "gpt", "value": ...}, ...]}
Text-only records have no "image" key. A small share has a list of images (multi-image).
The source mix imitates llava_v1_5_mix665k: templated short-answer VQA (ocr_vqa, gqa, textvqa, vg)
alongside free-form detailed answers (llava_instruct) and longer text-only chats (sharegpt).
"""
import json
import random
import sys
from pathlib import Path

out = Path(sys.argv[1])
scale = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
out.mkdir(parents=True, exist_ok=True)
rng = random.Random(1234)

STOP = ("the a an of to and in is on with for at by that this it as are from there be or its which "
        "image shows can you see two one some man woman people person table room street car dog cat "
        "white black red blue green large small left right top bottom front back near next while "
        "has have appears standing sitting holding wearing looking").split()
words = [w.strip() for w in open("/usr/share/dict/words") if w.strip().islower() and 3 <= len(w.strip()) <= 11]
rng.shuffle(words)
VOCAB = STOP + words[:12000]
WEIGHTS = [1.0 / (i + 1) ** 1.05 for i in range(len(VOCAB))]
CUM = []
acc = 0.0
for w in WEIGHTS:
    acc += w
    CUM.append(acc)


def sentence(n):
    ws = rng.choices(VOCAB, cum_weights=CUM, k=n)
    return " ".join(ws).capitalize() + "."


def para(lo, hi):
    n = rng.randint(lo, hi)
    parts, left = [], n
    while left > 0:
        k = min(left, rng.randint(6, 22))
        parts.append(sentence(k))
        left -= k
    return " ".join(parts)


OCR_Q = ["Who wrote this book?", "What is the title of this book?", "What is the genre of this book?",
         "Is this a comedy book?", "Is this book related to History?", "What type of book is this?",
         "Is this a sci-fi book?", "Is this a romantic book?"]
GQA_Q = ["What color is the {o}?", "Is the {o} to the left or to the right of the {p}?", "Which side is the {o} on?",
         "Are there both {o}s and {p}s in this picture?", "What is the {o} made of?", "Is the {o} large or small?",
         "What is in front of the {p}?", "Who is wearing the {o}?"]
OBJ = ["car", "bus", "shirt", "table", "chair", "dog", "cat", "window", "door", "tree", "sign", "bag", "plate",
       "fence", "building", "jacket", "helmet", "umbrella", "bike", "horse", "train", "clock", "cup", "bottle"]
COLORS = ["white", "black", "red", "blue", "green", "brown", "gray", "yellow", "orange", "silver"]
SHORT_SUFFIX = "\nAnswer the question using a single word or phrase."


def img_id(i):
    return f"{i:012d}"


def rec_ocr(i):
    conv = []
    for t in range(rng.randint(3, 5)):
        q = rng.choice(OCR_Q)
        a = rng.choice(["Yes", "No"]) if q.startswith("Is") else para(2, 7).rstrip(".")
        conv += [{"from": "human", "value": ("<image>\n" if t == 0 else "") + q}, {"from": "gpt", "value": a}]
    bid = f"{rng.randint(10**9, 10**10 - 1)}"
    return {"id": bid, "image": f"ocr_vqa/images/{bid}.jpg", "conversations": conv}


def rec_gqa(i):
    conv = []
    for t in range(rng.randint(2, 8)):
        q = rng.choice(GQA_Q).format(o=rng.choice(OBJ), p=rng.choice(OBJ))
        a = rng.choice(COLORS + OBJ + ["Yes", "No", "left", "right", "wood", "metal", "plastic"])
        conv += [{"from": "human", "value": ("<image>\n" if t == 0 else "") + q + (SHORT_SUFFIX if t == 0 else "")},
                 {"from": "gpt", "value": a}]
    n = rng.randint(1, 2400000)
    return {"id": str(n), "image": f"gqa/images/{n}.jpg", "conversations": conv}


def rec_textvqa(i):
    n = rng.randrange(16 ** 15)
    q = "What does the sign say?" if rng.random() < 0.3 else sentence(rng.randint(5, 10)).replace(".", "?")
    return {"id": f"{n:016x}", "image": f"textvqa/train_images/{n:016x}.jpg",
            "conversations": [{"from": "human", "value": "<image>\n" + q + "\nReference OCR token: " + para(3, 20) + SHORT_SUFFIX},
                              {"from": "gpt", "value": para(1, 3).rstrip(".")}]}


def rec_instruct(i):
    cid = rng.randint(1, 581929)
    conv = []
    turns = 1 if rng.random() < 0.45 else rng.randint(2, 5)
    for t in range(turns):
        q = sentence(rng.randint(6, 16)).replace(".", "?")
        if t == 0:
            q = ("<image>\n" + q) if rng.random() < 0.5 else (q + "\n<image>")
        conv += [{"from": "human", "value": q}, {"from": "gpt", "value": para(40, 220) if turns == 1 else para(15, 90)}]
    return {"id": img_id(cid), "image": f"coco/train2017/{img_id(cid)}.jpg", "conversations": conv}


def rec_vg(i):
    n = rng.randint(1, 2417997)
    conv = []
    for t in range(rng.randint(2, 6)):
        q = f"Please provide a short description for this region: [{rng.random():.2f}, {rng.random():.2f}, {rng.random():.2f}, {rng.random():.2f}]."
        conv += [{"from": "human", "value": ("<image>\n" if t == 0 else "") + q}, {"from": "gpt", "value": para(3, 9).rstrip(".")}]
    return {"id": f"VG_100K_{n}", "image": f"vg/VG_100K/{n}.jpg", "conversations": conv}


def rec_sharegpt(i):
    chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    sid = "".join(rng.choice(chars) for _ in range(7)) + f"_{rng.randint(0, 9)}"
    conv = []
    for t in range(rng.randint(1, 6)):
        conv += [{"from": "human", "value": para(8, 80)}, {"from": "gpt", "value": para(60, 400)}]
    return {"id": sid, "model": "", "conversations": conv}


def rec_multi(i):
    k = rng.randint(2, 4)
    n = rng.randint(1, 10**7)
    imgs = [f"M4-Instruct-Data/{n}_{j}.jpg" for j in range(k)]
    conv = [{"from": "human", "value": "<image>\n" * k + sentence(rng.randint(8, 20)).replace(".", "?")},
            {"from": "gpt", "value": para(20, 120)}]
    return {"id": f"m4_{n}", "image": imgs, "conversations": conv}


def write_json(path, mix, n):
    gens, weights = zip(*mix)
    with open(path, "w") as f:
        f.write("[")
        for i in range(n):
            if i:
                f.write(", ")
            json.dump(rng.choices(gens, weights=weights)[0](i), f)
        f.write("]")


def write_jsonl(path, mix, n):
    gens, weights = zip(*mix)
    with open(path, "w") as f:
        for i in range(n):
            f.write(json.dumps(rng.choices(gens, weights=weights)[0](i)) + "\n")


S = lambda n: int(n * scale)
write_json(out / "llava_v1_5_mix665k.json",
           [(rec_instruct, 158), (rec_ocr, 80), (rec_gqa, 72), (rec_textvqa, 22), (rec_vg, 86), (rec_sharegpt, 40),
            (rec_gqa, 100), (rec_ocr, 107)], S(665000))
write_json(out / "si_mix.json", [(rec_instruct, 40), (rec_textvqa, 30), (rec_gqa, 20), (rec_multi, 10)], S(300000))
write_jsonl(out / "text_mix.jsonl", [(rec_sharegpt, 70), (rec_instruct, 30)], S(150000))

(out / "mix.yaml").write_text(
    "datasets:\n"
    f"  - json_path: {out / 'llava_v1_5_mix665k.json'}\n    sampling_strategy: all\n"
    f"  - json_path: {out / 'si_mix.json'}\n    sampling_strategy: end:200000\n"
    f"  - json_path: {out / 'text_mix.jsonl'}\n    sampling_strategy: first:80%\n"
)
(out / "mix_random.yaml").write_text(
    "datasets:\n"
    f"  - json_path: {out / 'si_mix.json'}\n    sampling_strategy: random:50%\n"
    f"  - json_path: {out / 'text_mix.jsonl'}\n    sampling_strategy: random:20000\n"
)
