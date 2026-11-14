### fork

| Arm |  | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above import-matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled to each worker | workers seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | list | 3,604 | same | 3,528 | +3,289 | +3,335 (E0) | 0 | 3,115 | 0.32 | 2.01 |  | 4 |
| B1 | HF Arrow mmap | 994 | same | 269 | +30 | +30 (E) | 0 | 378 | 0.04 | 0.63 |  | 4 |
| V2S | packmem share() /dev/shm | 559 | 593 | 207 |  | +14 (E0) | 275 | 249 | 0.03 | 0.35 | 136 B | 4 |
| V2O | packmem save()+open() | 549 | same | 197 |  | +4 (E0) | 0 | 245 | 0.03 | 0.34 | 134 B | 4 |
| E | floor, imports datasets+pyarrow+packmem | 358 | same | 239 |  |  | 0 | 327 | 0.05 | 0.35 |  | 4 |
| E0 | floor, imports packmem only | 270 | same | 193 |  |  | 0 | 228 | 0.02 | 0.29 |  | 4 |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| A | 120-121 | 724-725 | 120-121 | 721-722 |
| B1 | 50-53 | 205-207 | 12 | 53-54 |
| V2S | 26-27 | 111-113 | 26-27 | 41-42 |
| V2O | 24-26 | 109-111 | 9 | 39 |
| E | 6 | 49-50 | 6 | 47-48 |
| E0 | 8 | 41 | 8 | 38-39 |

| Arm | file | worker map Rss (end) | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss | worker map peak Rss |
|---|---|---|---|---|---|---|---|---|
| B1 | arrow | 406-407 | 367-368 | 38-41 | 0 | 0 | 148-150 | 406-407 |
| V2S | pkm | 175-178 | 0 | 0 | 159-161 | 15-17 | 67-69 | 175-178 |
| V2O | pkm | 175-178 | 159-161 | 15-17 | 0 | 0 | 67-69 | 175-178 |

### forkserver

| Arm |  | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above import-matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled to each worker | workers seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | list | 15,961 | same | 15,884 | +15,043 | +15,099 (E0) | 0 | 3,810 | 63.47 | 65.74 | 687.4 MB | 4 |
| B1 | HF Arrow mmap | 1,810 | same | 1,083 | +243 | +243 (E) | 0 | 379 | 1.80 | 2.61 | 2,230 B | 4 |
| V2S | packmem share() /dev/shm | 1,148 | 1,182 | 795 |  | +10 (E0) | 275 | 249 | 1.07 | 1.49 | 136 B | 4 |
| V2O | packmem save()+open() | 1,144 | same | 790 |  | +5 (E0) | 0 | 245 | 1.02 | 1.41 | 134 B | 4 |
| E | floor, imports datasets+pyarrow+packmem | 961 | same | 840 |  |  | 0 | 327 | 1.02 | 1.38 | 151 B | 4 |
| E0 | floor, imports packmem only | 863 | same | 785 |  |  | 0 | 228 | 0.94 | 1.26 | 151 B | 4 |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| A | 3,026-3,293 | 3,041-3,307 | 3,026-3,293 | 3,026-3,293 |
| B1 | 251-257 | 385-387 | 213 | 213 |
| V2S | 170-179 | 237-239 | 170-179 | 155 |
| V2O | 170-176 | 237-239 | 155 | 155 |
| E | 154 | 169 | 154 | 154 |
| E0 | 154 | 169 | 154 | 154 |

| Arm | file | worker map Rss (end) | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss | worker map peak Rss |
|---|---|---|---|---|---|---|---|---|
| B1 | arrow | 406-408 | 367-369 | 38-41 | 0 | 0 | 148-150 | 406-408 |
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

- V2S/fork: tmpfs /dev/shm/, size 308,680,442 B, mode 0o600, share_s 0.191, exists at end of run (before exit): [True, True, True]
- V2S/forkserver: tmpfs /dev/shm/, size 308,680,442 B, mode 0o600, share_s 0.184, exists at end of run (before exit): [True, True, True]
- V2O/fork: disk $WORK/pkm/, size 308,680,442 B, mode 0o664, share_s 0.003, exists at end of run (before exit): [True, True, True]
- V2O/forkserver: disk $WORK/pkm/, size 308,680,442 B, mode 0o664, share_s 0.003, exists at end of run (before exit): [True, True, True]

Distinct batch digests across data arms: 1
- debc56792e4b2a2eb457fa213fddff123f3639c962b60c6acd2e59bd6578714f: 24 runs (A/fork, A/forkserver, B1/fork, B1/forkserver, V2O/fork, V2O/forkserver, V2S/fork, V2S/forkserver)

### Loads

- phase `prep` started 2026-11-14T02:05:39+01:00
- prep_ids [venv020]: rc=0 load 26.29 -> 27.89, wall 33.9 s, avail 94 GB, /dev/shm pkm 0->0
- conv_B1 [venv020]: rc=0 load 27.89 -> 28.86, wall 23.9 s, avail 97 GB, /dev/shm pkm 0->0
- hash_B1 [venv020]: rc=0 load 28.86 -> 29.12, wall 23.9 s, avail 97 GB, /dev/shm pkm 0->0
- prep_v2save [venv020]: rc=0 load 29.12 -> 27.59, wall 26.6 s, avail 102 GB, /dev/shm pkm 0->0
- hash_V2O [venv020]: rc=0 load 27.59 -> 25.4, wall 18.2 s, avail 104 GB, /dev/shm pkm 0->0
- hash_V2S [venv020]: rc=0 load 25.4 -> 22.32, wall 26.3 s, avail 105 GB, /dev/shm pkm 0->0
- import_cost [venv020]: rc=0 load 22.32 -> 16.74, wall 34.0 s, avail 106 GB, /dev/shm pkm 0->0
- diag_share_norm [venv020]: rc=0 load 16.74 -> 15.71, wall 7.6 s, avail 109 GB, /dev/shm pkm 0->0
- phase `dl` started 2026-11-14T02:08:54+01:00
- dl_A_fork_1 [venv020]: rc=0 load 15.71 -> 14.77, wall 15.2 s, avail 109 GB, /dev/shm pkm 0->0
- dl_B1_fork_1 [venv020]: rc=0 load 14.77 -> 14.77, wall 3.8 s, avail 108 GB, /dev/shm pkm 0->0
- dl_V2S_fork_1 [venv020]: rc=0 load 14.77 -> 14.1, wall 10.7 s, avail 109 GB, /dev/shm pkm 0->0
- dl_V2O_fork_1 [venv020]: rc=0 load 13.45 -> 13.45, wall 2.8 s, avail 106 GB, /dev/shm pkm 0->0
- dl_E_fork_1 [venv020]: rc=0 load 13.45 -> 12.77, wall 3.4 s, avail 108 GB, /dev/shm pkm 0->0
- dl_E0_fork_1 [venv020]: rc=0 load 12.77 -> 12.77, wall 2.6 s, avail 109 GB, /dev/shm pkm 0->0
- dl_A_forkserver_1 [venv020]: rc=0 load 12.77 -> 10.5, wall 72.4 s, avail 109 GB, /dev/shm pkm 0->0
- dl_B1_forkserver_1 [venv020]: rc=0 load 10.5 -> 10.06, wall 5.1 s, avail 107 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_1 [venv020]: rc=0 load 10.06 -> 9.82, wall 11.2 s, avail 107 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_1 [venv020]: rc=0 load 9.82 -> 9.91, wall 3.4 s, avail 108 GB, /dev/shm pkm 0->0
- dl_E_forkserver_1 [venv020]: rc=0 load 9.91 -> 9.92, wall 3.9 s, avail 110 GB, /dev/shm pkm 0->0
- dl_E0_forkserver_1 [venv020]: rc=0 load 9.92 -> 9.92, wall 3.2 s, avail 110 GB, /dev/shm pkm 0->0
- dl_A_fork_2 [venv020]: rc=0 load 9.92 -> 11.0, wall 15.8 s, avail 109 GB, /dev/shm pkm 0->0
- dl_B1_fork_2 [venv020]: rc=0 load 11.0 -> 11.72, wall 4.2 s, avail 109 GB, /dev/shm pkm 0->0
- dl_V2S_fork_2 [venv020]: rc=0 load 11.72 -> 12.46, wall 11.5 s, avail 108 GB, /dev/shm pkm 0->0
- dl_V2O_fork_2 [venv020]: rc=0 load 12.46 -> 12.46, wall 3.3 s, avail 103 GB, /dev/shm pkm 0->0
- dl_E_fork_2 [venv020]: rc=0 load 12.46 -> 12.59, wall 3.5 s, avail 103 GB, /dev/shm pkm 0->0
- dl_E0_fork_2 [venv020]: rc=0 load 12.59 -> 12.59, wall 2.7 s, avail 104 GB, /dev/shm pkm 0->0
- dl_A_forkserver_2 [venv020]: rc=0 load 12.59 -> 24.8, wall 94.1 s, avail 104 GB, /dev/shm pkm 0->0
- dl_B1_forkserver_2 [venv020]: rc=0 load 24.8 -> 25.89, wall 7.5 s, avail 100 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_2 [venv020]: rc=0 load 25.89 -> 26.85, wall 14.2 s, avail 98 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_2 [venv020]: rc=0 load 26.85 -> 26.39, wall 4.6 s, avail 101 GB, /dev/shm pkm 0->0
- dl_E_forkserver_2 [venv020]: rc=0 load 26.39 -> 26.43, wall 5.5 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E0_forkserver_2 [venv020]: rc=0 load 26.43 -> 26.0, wall 4.5 s, avail 99 GB, /dev/shm pkm 0->0
- dl_A_fork_3 [venv020]: rc=0 load 26.0 -> 25.77, wall 20.5 s, avail 102 GB, /dev/shm pkm 0->0
- dl_B1_fork_3 [venv020]: rc=0 load 25.77 -> 25.71, wall 5.2 s, avail 99 GB, /dev/shm pkm 0->0
- dl_V2S_fork_3 [venv020]: rc=0 load 25.71 -> 25.75, wall 12.9 s, avail 103 GB, /dev/shm pkm 0->0
- dl_V2O_fork_3 [venv020]: rc=0 load 25.75 -> 25.69, wall 3.6 s, avail 98 GB, /dev/shm pkm 0->0
- dl_E_fork_3 [venv020]: rc=0 load 25.69 -> 25.71, wall 4.3 s, avail 101 GB, /dev/shm pkm 0->0
- dl_E0_fork_3 [venv020]: rc=0 load 25.71 -> 25.89, wall 3.1 s, avail 102 GB, /dev/shm pkm 0->0
- dl_A_forkserver_3 [venv020]: rc=0 load 25.89 -> 22.66, wall 95.5 s, avail 101 GB, /dev/shm pkm 0->0
- dl_B1_forkserver_3 [venv020]: rc=0 load 22.66 -> 22.21, wall 7.0 s, avail 103 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_3 [venv020]: rc=0 load 22.21 -> 22.18, wall 13.2 s, avail 102 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_3 [venv020]: rc=0 load 22.18 -> 21.6, wall 4.0 s, avail 102 GB, /dev/shm pkm 0->0
- dl_E_forkserver_3 [venv020]: rc=0 load 21.6 -> 21.6, wall 4.1 s, avail 104 GB, /dev/shm pkm 0->0
- dl_E0_forkserver_3 [venv020]: rc=0 load 21.6 -> 21.55, wall 3.6 s, avail 106 GB, /dev/shm pkm 0->0
