### fork

| Arm |  | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above import-matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled to each worker | workers seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| V2S | v2 share() /dev/shm | 634 | 668 | 282 |  | +89 (E0v2) | 275 | 324 | 0.03 | 0.50 | 136 B | 4 |
| E0v2 | floor, no datasets/pyarrow (venv v2) | 270 | same | 193 |  |  | 0 | 228 | 0.04 | 0.34 |  | 4 |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| V2S | 26-27 | 126-128 | 26-27 | 56 |
| E0v2 | 8 | 41 | 8 | 38 |

| Arm | file | worker map Rss (end) | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss | worker map peak Rss |
|---|---|---|---|---|---|---|---|---|
| V2S | pkm | 175-178 | 0 | 0 | 160-161 | 15-17 | 67-69 | 175-178 |

### forkserver

| Arm |  | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above import-matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled to each worker | workers seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| V2S | v2 share() /dev/shm | 1,223 | 1,257 | 870 |  | +85 (E0v2) | 275 | 324 | 1.21 | 1.61 | 136 B | 4 |
| V2O | v2 open(saved) | 1,144 | same | 790 |  | +6 (E0v2) | 0 | 245 | 0.99 | 1.50 | 134 B | 4 |
| E0v2 | floor, no datasets/pyarrow (venv v2) | 864 | same | 785 |  |  | 0 | 228 | 1.13 | 1.46 | 151 B | 4 |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| V2S | 170-178 | 237-239 | 170-178 | 155 |
| V2O | 170-178 | 237-239 | 155 | 155 |
| E0v2 | 154-156 | 169-171 | 154 | 154 |

| Arm | file | worker map Rss (end) | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss | worker map peak Rss |
|---|---|---|---|---|---|---|---|---|
| V2S | pkm | 175-178 | 0 | 0 | 160-161 | 15-17 | 67-69 | 175-178 |
| V2O | pkm | 175-178 | 160-161 | 15-17 | 0 | 0 | 67-69 | 175-178 |

### Per-row access, one process (s, median of 3; us/op in parentheses)

| Op | B1 | C | V2O |
|---|---|---|---|
| 100k random x[i] -> dict |  |  |  |
| 20k random x[i]['conversations'] |  |  |  |
| 2,000 random x[i:i+64] (per row) |  |  |  |
| full pass (per row) |  |  |  |
| pickle bytes |  |  |  |
| mem after pass Pss_Anon MB |  |  |  |
| mem after pass USS MB |  |  |  |
| mem after pass Rss MB |  |  |  |

### Shared / saved files

- V2S/fork: tmpfs /dev/shm/, size 308,680,442 B, mode 0o600, share_s 0.159, exists at end of run (before exit): [True, True, True]
- V2S/forkserver: tmpfs /dev/shm/, size 308,680,442 B, mode 0o600, share_s 0.177, exists at end of run (before exit): [True, True, True]
- V2O/forkserver: disk $WORK/pkm/, size 308,680,442 B, mode 0o664, share_s 0.002, exists at end of run (before exit): [True, True, True]

Distinct batch digests across data arms: 1
- debc56792e4b2a2eb457fa213fddff123f3639c962b60c6acd2e59bd6578714f: 9 runs (V2O/forkserver, V2S/fork, V2S/forkserver)

### Loads

- phase `prep` started 2026-11-14T01:06:46+01:00
- prep_v2save [venv2b]: rc=0 load 35.78 -> 36.92, wall 42.7 s, avail 96 GB, /dev/shm pkm 0->0
- hash_V2O [venv2b]: rc=0 load 36.92 -> 32.22, wall 22.4 s, avail 98 GB, /dev/shm pkm 0->0
- hash_V2S [venv2b]: rc=0 load 32.22 -> 27.68, wall 27.1 s, avail 97 GB, /dev/shm pkm 0->0
- phase `dl` started 2026-11-14T01:08:18+01:00
- dl_V2S_fork_1 [venv2b]: rc=0 load 27.68 -> 26.39, wall 12.3 s, avail 103 GB, /dev/shm pkm 0->0
- dl_E0v2_fork_1 [venv2b]: rc=0 load 26.39 -> 26.12, wall 3.1 s, avail 103 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_1 [venv2b]: rc=0 load 26.12 -> 25.87, wall 13.9 s, avail 105 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_1 [venv2b]: rc=0 load 25.87 -> 25.8, wall 4.5 s, avail 102 GB, /dev/shm pkm 0->0
- dl_E0v2_forkserver_1 [venv2b]: rc=0 load 25.8 -> 25.18, wall 4.0 s, avail 102 GB, /dev/shm pkm 0->0
- dl_V2S_fork_2 [venv2b]: rc=0 load 25.18 -> 23.92, wall 11.0 s, avail 102 GB, /dev/shm pkm 0->0
- dl_E0v2_fork_2 [venv2b]: rc=0 load 23.92 -> 24.17, wall 3.1 s, avail 105 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_2 [venv2b]: rc=0 load 24.17 -> 23.43, wall 13.2 s, avail 107 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_2 [venv2b]: rc=0 load 23.43 -> 23.43, wall 4.4 s, avail 104 GB, /dev/shm pkm 0->0
- dl_E0v2_forkserver_2 [venv2b]: rc=0 load 23.43 -> 23.24, wall 3.8 s, avail 104 GB, /dev/shm pkm 0->0
- dl_V2S_fork_3 [venv2b]: rc=0 load 23.24 -> 22.18, wall 10.7 s, avail 103 GB, /dev/shm pkm 0->0
- dl_E0v2_fork_3 [venv2b]: rc=0 load 22.18 -> 21.85, wall 2.3 s, avail 107 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_3 [venv2b]: rc=0 load 21.85 -> 21.56, wall 11.6 s, avail 107 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_3 [venv2b]: rc=0 load 21.56 -> 21.11, wall 3.5 s, avail 109 GB, /dev/shm pkm 0->0
- dl_E0v2_forkserver_3 [venv2b]: rc=0 load 21.11 -> 20.54, wall 3.6 s, avail 108 GB, /dev/shm pkm 0->0
