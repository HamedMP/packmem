"""A LLaVA-style fine-tuning dataset with its annotations held four ways.

Only `load_annotations` differs between the variants; `ConversationDataset` is the same for all of them. This is
the part a training repository changes: its dataset class keeps `list_data_dict = json.load(...)` and every
DataLoader worker gets a copy of it.
"""
import json
import os

from torch.utils.data import Dataset

MODES = ("list", "hf", "packmem", "packmem-open", "floor")


def load_annotations(path, mode, cache_dir):
    if mode == "list":
        with open(path) as f:
            return json.load(f)

    if mode == "packmem":
        import packmem

        # 0.1.2: written to one file, which each worker loads; on main, workers read the file in place
        return packmem.load_json(path).share()

    if mode == "packmem-open":
        import packmem

        if not hasattr(packmem, "open"):
            raise SystemExit(f"packmem {packmem.__version__} has no packmem.open(); it is new in the release after 0.1.2")
        saved = os.path.join(cache_dir, os.path.basename(path) + ".pkm")
        if not os.path.exists(saved):  # once, like the Arrow cache below
            packmem.load_json(path).save(saved)
        return packmem.open(saved)  # memory-mapped: every worker reads the same pages

    if mode == "hf":
        import datasets

        datasets.disable_progress_bars()
        # datasets' JSON loader rewrites ids it sees as mixed types (numbers and strings) without an error, so give it
        # every id as a string first; see README
        return datasets.load_dataset("json", data_files=ids_as_strings(path, cache_dir), split="train", cache_dir=cache_dir)

    if mode == "floor":
        # no data at all: what the interpreter, torch and the workers cost by themselves
        return Floor(200_000)

    raise ValueError(f"unknown mode {mode!r}; one of {', '.join(MODES)}")


class Floor:
    def __init__(self, n):
        self.n = n

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        return {"id": str(i), "conversations": [{"from": "human", "value": "x"}]}


def ids_as_strings(path, cache_dir):
    """The file itself when every id is already a string (llava_instruct_150k.json), else a copy with str(id)
    (llava_v1_5_mix665k.json mixes numbers and strings)."""
    out = os.path.join(cache_dir, os.path.basename(path) + ".idstr.json")
    if os.path.exists(out):
        return out
    with open(path) as f:
        rows = json.load(f)
    if all(isinstance(r["id"], str) for r in rows):
        os.symlink(os.path.abspath(path), out)  # checked once
        return out
    for r in rows:
        r["id"] = str(r["id"])
    with open(out, "w") as f:
        json.dump(rows, f)
    return out


class ConversationDataset(Dataset):
    """What a supervised fine-tuning dataset does per sample, minus the model: read one record, join its turns and
    measure it. A whitespace split stands in for the tokenizer."""

    def __init__(self, rows):
        self.rows = rows

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        text = "\n".join(turn["value"] for turn in r["conversations"])
        return str(r["id"]), len(text.split())


def collate(batch):
    ids, lengths = zip(*batch)
    return list(ids), list(lengths)
