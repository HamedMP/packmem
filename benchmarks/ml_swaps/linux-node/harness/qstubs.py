"""Stub processor for qwen-vl-finetune (from the macOS harness bench_v2.py) and DataLoader worker probes.

Importable by spawn/forkserver workers. Probes write one JSON file per worker to $PROBE_DIR.
"""
import json
import os
import time
import zlib

import torch


class StubTokenizer:
    pad_token_id = 151643
    model_max_length = 4096

    def decode(self, ids, skip_special_tokens=False):
        return " ".join(str(int(t)) for t in ids[:8])


class StubImageProcessor:
    min_pixels = max_pixels = 0
    merge_size = 2

    def __init__(self):
        self.size = {"shortest_edge": 0, "longest_edge": 0}


class StubProcessor:
    """Tokenizes text and media paths deterministically; no image decoding."""

    video_processor = None

    def __init__(self):
        self.image_processor = StubImageProcessor()
        self.tokenizer = StubTokenizer()

    def apply_chat_template(self, messages, tokenize, return_dict, return_tensors):
        ids = []
        for m in messages:
            ids += [151644, 77091 if m["role"] == "assistant" else 872, 198]
            for c in m["content"]:
                s = c.get("text") or c.get("image") or c.get("video")
                ids += [zlib.crc32(w.encode()) % 150000 for w in s.split()]
            ids += [151645, 198]
        t = torch.tensor([ids])
        return {"input_ids": t, "attention_mask": torch.ones_like(t)}


_state = {}


def _write():
    d = os.environ.get("PROBE_DIR")
    if not d:
        return
    tmp = os.path.join(d, f".{os.getpid()}.tmp")
    with open(tmp, "w") as f:
        json.dump(_state, f)
    os.replace(tmp, os.path.join(d, f"w{os.getpid()}.json"))


def _proc_start_time(pid):
    with open(f"/proc/{pid}/stat") as f:
        ticks = int(f.read().rsplit(")", 1)[1].split()[19])
    with open("/proc/stat") as f:
        btime = next(int(l.split()[1]) for l in f if l.startswith("btime"))
    return btime + ticks / os.sysconf("SC_CLK_TCK")


def worker_init(wid):
    _state.update(wid=wid, pid=os.getpid(), ppid=os.getppid(), rank=int(os.environ.get("RANK", "-1")),
                  create=_proc_start_time(os.getpid()), init=time.time())
    _write()


class CollateProbe:
    def __init__(self, fn):
        self.fn = fn

    def __call__(self, batch):
        out = self.fn(batch)
        if "wid" in _state and "first_batch" not in _state:
            _state["first_batch"] = time.time()
            _write()
        return out
