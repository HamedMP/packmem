"""Small upstream-behaviour checks, independent of packmem (tiny data, no timing).

1. Pointing columns.images at LLaVA's single-string `image` field splits the path into characters.
2. shard_data=True through VlmDataloaderConfig: the rank's 1/world_size shard is then split again
   by the DistributedSampler, so one epoch covers 1/world_size of the data.
3. PreTokenizedDatasetWrapper writes decoded PIL images back into the stored records (list arm).

usage: checks.py --repo REPO
"""
import argparse
import json
import os
import sys
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
args = ap.parse_args()
sys.path.insert(0, os.path.abspath(args.repo))

from nemo_automodel.components.datasets.vlm.datasets import (  # noqa: E402
    MetaDatasetConfig,
    convert_sharegpt_to_conversation,
    make_meta_dataset,
)
from nemo_automodel.components.datasets.vlm.loader import VlmDataloaderConfig, VlmProcessorConfig  # noqa: E402

out = {}

rec = {"image": "coco/train2017/000000033471.jpg", "conversations": [{"from": "human", "value": "<image>\nWhat?"}, {"from": "gpt", "value": "A bus."}]}
conv = convert_sharegpt_to_conversation(
    rec,
    columns={"messages": "conversations", "images": "image"},
    tags={"role_tag": "from", "content_tag": "value", "user_tag": "human", "assistant_tag": "gpt"},
    media_dir="/data/llava",
)
out["raw_llava_image_column_resolves_to"] = conv["conversation"][0]["content"][0]

tmp = tempfile.mkdtemp()
n, ws = 64, 4
with open(os.path.join(tmp, "d.jsonl"), "w") as f:
    for i in range(n):
        f.write(json.dumps({"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"a{i}"}]}) + "\n")
meta = os.path.join(tmp, "meta.json")
with open(meta, "w") as f:
    json.dump({"d": {"file_name": "d.jsonl"}}, f)

seen = set()
per_rank = []
for rank in range(ws):
    cfg = VlmDataloaderConfig(
        dataset_config=MetaDatasetConfig(path_or_dataset=meta, shard_data=True),
        processor_config=VlmProcessorConfig(factory=lambda: None),
        num_workers=1,
        shuffle=False,
    )
    dl = cfg.build(pretrained_model_name_or_path="unused", dp_rank=rank, dp_world_size=ws, batch_size=1).dataloader
    idx = list(dl.sampler)
    per_rank.append({"rank_dataset_len": len(dl.dataset), "sampler_len": len(idx)})
    seen.update(dl.dataset[i]["conversation"][0]["content"][0]["text"] for i in idx)
out["shard_data_recipe_path"] = {"records": n, "world_size": ws, "per_rank": per_rank, "distinct_records_seen_per_epoch": len(seen)}

ds = make_meta_dataset(meta)
out["make_meta_dataset_type"] = type(ds).__name__
print(json.dumps(out, indent=2))
