"""The repository's LazySupervisedDataset with image decoding and tokenization stubbed out.

Everything else in __getitem__/_get_item (the list_data_dict lookups, the deepcopy of the
conversations, preprocess_multimodal, the retry logic) is the repository's code. Importable, so
spawn workers get the same stubs.
"""
import os, sys, zlib
from types import SimpleNamespace

sys.path.insert(1, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import torch
import llava_import

t = llava_import.load_train_module()


class StubTokenizer:
    padding_side = "right"
    pad_token_id = 0
    model_max_length = 4096


class StubImageProcessor:
    crop_size = {"height": 4, "width": 4}


def stub_preprocess(sources, tokenizer, has_image=False):
    ids, labels = [], []
    for conv in sources:
        for s in conv:
            words = [1 if s["from"] == "human" else 2] + [3 + zlib.crc32(w.encode()) % 32000 for w in s["value"].split()]
            ids += words
            labels += [-100] * len(words) if s["from"] == "human" else words
    return dict(input_ids=torch.tensor([ids]), labels=torch.tensor([labels]))


t.preprocess = stub_preprocess


class ProbeDataset(t.LazySupervisedDataset):
    def process_image(self, image_file, overwrite_image_aspect_ratio=None):
        h = zlib.crc32(image_file.encode())
        return torch.full((3, 4, 4), h % 251, dtype=torch.uint8), (14 * (2 + h % 3), 14 * (2 + (h >> 4) % 3)), "image"


def data_args():
    return SimpleNamespace(early_mix_text=False, is_multimodal=True, mm_use_im_start_end=False,
                           image_processor=StubImageProcessor())


def collator():
    return t.DataCollatorForSupervisedDataset(tokenizer=StubTokenizer())
