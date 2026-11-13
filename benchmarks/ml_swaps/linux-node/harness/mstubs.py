"""Stubs for MiniCPM-V's finetune/dataset.py (from the macOS harness mstubs.py), importable by spawn workers."""
import re
import types
import zlib

from PIL import Image
import dataset as ds
import qstubs


def fake_open(path):
    h = zlib.crc32(str(path).encode())
    w, hh = 14 * (2 + h % 3), 14 * (2 + (h >> 4) % 3)
    return Image.new("RGB", (w, hh), (h & 255, (h >> 8) & 255, (h >> 16) & 255))


def install():
    ds.logger.disabled = True
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


def worker_init(wid):
    install()
    qstubs.worker_init(wid)
