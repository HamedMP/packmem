| config | runs | ranks x workers | samples/rank | node PSS peak GiB | node PSS steady GiB | pre-iteration peak GiB | sum RSS peak GiB | per-rank total at peak GiB | rank peak PSS GiB | worker peak PSS GiB (median) | worker USS GiB | build s | loader s | worker 1st batch s (median/max) | load start -> end |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m_forkserver_list_2x4 | 3 | 2x4 forkserver | 20000 | 31.57 (31.42-31.61) | 30.68 (30.66-30.70) | 8.23 (8.23-8.23) | 32.52 (32.38-32.56) | 15.71 (15.63-15.73) | 5.12 (5.12-5.12) | 3.26 (3.26-3.26) | 3.25 (3.25-3.25) | 6.96 (6.45-8.90) | 201.11 (168.94-219.75) | 75.18 / 77.08 | 39.17->52.68; 37.98->46.95; 35.37->28.45 |
| m_forkserver_pm_2x4 | 3 | 2x4 forkserver | 20000 | 6.41 (6.41-6.51) | 6.34 (6.34-6.36) | 1.51 (1.51-1.51) | 7.42 (7.41-7.52) | 3.13 (3.13-3.18) | 1.19 (1.19-1.21) | 0.64 (0.63-0.64) | 0.63 (0.62-0.63) | 14.40 (13.84-15.01) | 109.44 (105.54-109.93) | 22.42 / 22.71 | 28.16->39.17; 52.68->37.98; 46.95->35.37 |

Hashes per rank (input_ids, labels, position_ids; first 16 hex) and DistributedSampler index hashes:
- samples/rank 20000, rank 0: identical across 6 runs -> ('59416b8b0d4d029e', 'e94e6c6b528261f0', '3f5bddf67537a387')
- samples/rank 20000, rank 1: identical across 6 runs -> ('93f554ef2ca7dc28', 'ba581276317a8fa1', '28c4f25f9d49ce38')
