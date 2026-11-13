"""Build MiniCPM-V's train dataset via finetune.make_supervised_data_module and read
N random samples through a DataLoader. Prints one JSON line with timings, memory and a
hash of every tensor produced."""
import argparse, gc, hashlib, json, os, random, re, sys, time, types, zlib

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--data", required=True)
ap.add_argument("--n", type=int, default=20000)
ap.add_argument("--workers", type=int, default=0)
ap.add_argument("--batch", type=int, default=8)
ap.add_argument("--mp-context", default="fork")
args = ap.parse_args()

sys.path.insert(0, os.path.join(args.repo, "finetune"))
import psutil, torch
from PIL import Image
from torchvision import transforms
import finetune as ft
import dataset as ds

ds.logger.disabled = True


def fake_open(path):
    h = zlib.crc32(str(path).encode())
    w, hh = 14 * (2 + h % 3), 14 * (2 + (h >> 4) % 3)
    return Image.new("RGB", (w, hh), (h & 255, (h >> 8) & 255, (h >> 16) & 255))


ds.Image = types.SimpleNamespace(open=fake_open, Resampling=Image.Resampling)


class StubTokenizer:
    """Deterministic word-level tokenizer exposing the attributes MiniCPM-V's qwen path reads."""
    im_start, im_end, unk_token, eos_token = "<image>", "</image>", "<unk>", "<|im_end|>"
    im_id_start, im_id_end, slice_start, slice_end = "<image_id>", "</image_id>", "<slice>", "</slice>"
    special = {"<unk>": 0, "<|im_end|>": 2, "<|im_start|>": 3, "<image>": 101, "</image>": 102,
               "<image_id>": 103, "</image_id>": 104, "<slice>": 105, "</slice>": 106}
    im_start_id, im_end_id, slice_start_id, slice_end_id, eos_id = 101, 102, 105, 106, 2
    _re = re.compile("(" + "|".join(re.escape(k) for k in special) + r")|\n|[^\s<]+|<")

    def convert_tokens_to_ids(self, t):
        return self.special.get(t, 200 + zlib.crc32(t.encode()) % 60000)

    def encode(self, s):
        return [self.convert_tokens_to_ids(m.group(0)) for m in self._re.finditer(s)]

    def apply_chat_template(self, chat, tokenize=False, add_generation_prompt=False, enable_thinking=False):
        text = "".join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n" for m in chat)
        return self.encode(text) if tokenize else text


import ctypes, tempfile, threading
MEMDIR = tempfile.mkdtemp(prefix="wmem-")
_libc = ctypes.CDLL(None)


def footprint():
    """(current, lifetime peak) phys_footprint of this process via proc_pid_rusage(RUSAGE_INFO_V4).
    Unlike RSS this includes pages macOS has compressed."""
    buf = (ctypes.c_uint64 * 64)()
    if _libc.proc_pid_rusage(os.getpid(), 4, buf) != 0:
        return 0, 0
    return buf[2 + 7], buf[2 + 28]


def worker_init(_):
    # macOS denies reading another process's USS, so each worker records its own peak
    def loop():
        path = os.path.join(MEMDIR, str(os.getpid()))
        while True:
            with open(path, "w") as f:
                f.write(str(footprint()[1]))
            time.sleep(0.2)
    threading.Thread(target=loop, daemon=True).start()


def mem():
    kids = 0
    for name in os.listdir(MEMDIR):
        with open(os.path.join(MEMDIR, name)) as f:
            kids += int(f.read() or 0)
    return footprint()[0], kids


t0 = time.perf_counter()
mod = ft.make_supervised_data_module(
    tokenizer=StubTokenizer(),
    data_args=types.SimpleNamespace(data_path=args.data, eval_data_path=None),
    transform=transforms.ToTensor(),
    data_collator=ds.data_collator,
    llm_type="qwen",
    slice_config={"patch_size": 14, "max_slice_nums": 9, "scale_resolution": 448},
    patch_size=14,
    query_nums=64,
    batch_vision=True,
    max_length=2048,
)
train = mod["train_dataset"]
gc.collect()
t_load = time.perf_counter() - t0
rss_loaded = footprint()[0]

g = torch.Generator().manual_seed(0)
idx = torch.randperm(len(train), generator=g)[: args.n].tolist()
torch.manual_seed(0)
random.seed(0)
dl = torch.utils.data.DataLoader(
    train, batch_size=args.batch, sampler=idx, num_workers=args.workers,
    collate_fn=mod["data_collator"], worker_init_fn=worker_init,
    multiprocessing_context=args.mp_context if args.workers else None,
)
h = hashlib.sha256()
peak_main = peak_kids = peak_total = 0
t1 = time.perf_counter()
for b, batch in enumerate(dl):
    for k in ("input_ids", "position_ids", "labels", "attention_mask"):
        h.update(batch[k].numpy().tobytes())
    for sample in batch["pixel_values"]:
        for t in sample:
            h.update(t.numpy().tobytes())
    for bound in batch["image_bound"]:
        h.update(bound.numpy().tobytes() if torch.is_tensor(bound) else b"[]")
    for ts in batch["tgt_sizes"]:
        h.update(ts.numpy().tobytes() if torch.is_tensor(ts) else b"[]")
    if b % 100 == 99:
        m, k = mem()
        peak_main, peak_kids, peak_total = max(peak_main, m), max(peak_kids, k), max(peak_total, m + k)
t_iter = time.perf_counter() - t1
m, k = mem()
peak_main, peak_kids, peak_total = max(peak_main, m), max(peak_kids, k), max(peak_total, m + k)
print(json.dumps({
    "records": len(train), "load_s": round(t_load, 3), "iter_s": round(t_iter, 3),
    "footprint_after_load_mb": round(rss_loaded / 2**20, 1),
    "main_footprint_during_iter_mb": round(peak_main / 2**20, 1),
    "workers_peak_footprint_sum_mb": round(peak_kids / 2**20, 1),
    "main_plus_workers_footprint_mb": round(peak_total / 2**20, 1),
    "main_lifetime_peak_footprint_mb": round(footprint()[1] / 2**20, 1),
    "type": type(train.raw_data).__name__, "sha256": h.hexdigest(),
}))
import shutil; shutil.rmtree(MEMDIR, ignore_errors=True)
