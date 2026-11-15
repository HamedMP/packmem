| config | runs | ranks x workers | samples/rank | node PSS peak GiB | node PSS steady GiB | pre-iteration peak GiB | sum RSS peak GiB | per-rank total at peak GiB | rank peak PSS GiB | worker peak PSS GiB (median) | worker USS GiB | build s | loader s | worker 1st batch s (median/max) | load start -> end |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| q_fork_pm_8x4 | 3 | 8x4 fork | 20000 | 4.47 (4.47-4.50) | 4.45 (4.45-4.45) | 4.34 (4.27-4.50) | 20.41 (20.39-20.42) | 0.54 (0.54-0.55) | 0.53 (0.53-0.55) | 0.11 (0.11-0.11) | 0.01 (0.01-0.01) | 3.75 (3.73-3.82) | 8.86 (8.83-8.98) | 0.07 / 0.09 | 1.09->7.60; 3.60->11.35; 3.93->10.72 |
| q_shard_fork_pm_8x4 | 1 | 8x4 fork | 83163 | 6.12 | 6.07 | 4.61 | 21.01 | 0.75 | 0.56 | 0.15 | 0.06 | 3.91 | 36.73 | 0.08 / 0.10 | 4.00->17.70 |

Hashes per rank (input_ids, labels, position_ids; first 16 hex) and DistributedSampler index hashes:
- samples/rank 20000, rank 0: identical across 3 runs -> ('619afe7b63985e93', '776a1b7955fad35f', 'bac2c498c1619d63')
- samples/rank 20000, rank 1: identical across 3 runs -> ('43369e7e4eff1d14', '62f96d8c92130697', '5c15f5bbd94cccf6')
- samples/rank 20000, rank 2: identical across 3 runs -> ('7bb922ebf229c3fc', 'e659c5522fb73e25', 'a7daee5173cb34a2')
- samples/rank 20000, rank 3: identical across 3 runs -> ('b2510f8ddb7d89d6', 'b5ecc9a780a1d6d3', '56c257ce4ae821da')
- samples/rank 20000, rank 4: identical across 3 runs -> ('a2f3c43a79b6a4a3', 'fb751fdcdb77ed43', 'f8de5fdf3755c280')
- samples/rank 20000, rank 5: identical across 3 runs -> ('7b8cd75358ce8190', '065b69d872bf8e70', '6fbf14fd338769fb')
- samples/rank 20000, rank 6: identical across 3 runs -> ('fcf2f1dd90f5af6c', '0737284c341b36e7', '045cdf784ef9a9a2')
- samples/rank 20000, rank 7: identical across 3 runs -> ('ac1b244be4090093', '04b53122ce1eb6df', '5c5b6f1b67194897')
- samples/rank 83163, rank 0: identical across 1 runs -> ('8038386d8b081ea7', 'bec837a3079f0e36', 'eeeb9dc6c47b2f19')
- samples/rank 83163, rank 1: identical across 1 runs -> ('e9f5f74a38ee0f4e', '1dd63d905fee62b4', 'b74833b6e70876b1')
- samples/rank 83163, rank 2: identical across 1 runs -> ('a04dbbb1a5455419', 'e70a746ed6f124e1', 'fa97ea315a570838')
- samples/rank 83163, rank 3: identical across 1 runs -> ('18ed32f491912c8d', '1d503e59dc35b107', '48e70f1fb88ae889')
- samples/rank 83163, rank 4: identical across 1 runs -> ('f5c79db694fda569', '4aa057170be043c4', 'c283fddc737caa38')
- samples/rank 83163, rank 5: identical across 1 runs -> ('5b0a825deb97dce4', 'ef5e231508f8f042', 'afce42c21365e3b4')
- samples/rank 83163, rank 6: identical across 1 runs -> ('fa686ed6a46538b3', '2bfb16b902221329', '26b881a482541c36')
- samples/rank 83163, rank 7: identical across 1 runs -> ('7f5128b324069a4a', 'cc670a497fea1c7b', '3d99f5b0dac8ea79')
