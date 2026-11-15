| config | runs | ranks x workers | samples/rank | node PSS peak GiB | node PSS steady GiB | pre-iteration peak GiB | sum RSS peak GiB | per-rank total at peak GiB | rank peak PSS GiB | worker peak PSS GiB (median) | worker USS GiB | build s | loader s | worker 1st batch s (median/max) | load start -> end |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m_fork_pm_8x4 | 3 | 8x4 fork | 20000 | 7.25 (7.23-7.25) | 7.14 (7.11-7.16) | 5.62 (5.43-5.73) | 26.31 (26.28-26.33) | 0.89 (0.88-0.89) | 0.68 (0.66-0.70) | 0.19 (0.19-0.19) | 0.08 (0.08-0.08) | 2.87 (2.75-2.91) | 162.56 (162.04-165.52) | 0.28 / 0.38 | 3.92->46.03; 3.57->38.30; 3.79->40.17 |

Hashes per rank (input_ids, labels, position_ids; first 16 hex) and DistributedSampler index hashes:
- samples/rank 20000, rank 0: identical across 3 runs -> ('59416b8b0d4d029e', 'e94e6c6b528261f0', '3f5bddf67537a387')
- samples/rank 20000, rank 1: identical across 3 runs -> ('93f554ef2ca7dc28', 'ba581276317a8fa1', '28c4f25f9d49ce38')
- samples/rank 20000, rank 2: identical across 3 runs -> ('30053b6ca4f182c2', '664c41c8d49afc26', '86413c0d5ac66ded')
- samples/rank 20000, rank 3: identical across 3 runs -> ('366abca11a1569d1', 'e4a2e7fcf3fab8db', 'c2e6c2fd9723500a')
- samples/rank 20000, rank 4: identical across 3 runs -> ('f989c2ed8691a3b3', 'b7a3362998770c8b', 'eae71472231bff41')
- samples/rank 20000, rank 5: identical across 3 runs -> ('d70ff8b0f5848dc1', 'c9ba1c3e93fb8a44', '6ebc33851b6f8097')
- samples/rank 20000, rank 6: identical across 3 runs -> ('ffff1278773898f6', '1ca1472b06f57e36', '006b334ae8a4d8a5')
- samples/rank 20000, rank 7: identical across 3 runs -> ('86066ba03451e9e7', '5ed60b82b49c14ff', '8a808d4e5a91db2e')
