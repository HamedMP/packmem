### fork

| Arm |  | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above import-matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled to each worker | workers seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | list | 3,605 | same | 3,528 | +3,289 | +3,335 (E0) | 0 | 3,115 | 0.51 | 3.37 |  | 4 |
| B1 | HF Arrow mmap | 994 | same | 269 | +30 | +30 (E) | 0 | 378 | 0.06 | 0.97 |  | 4 |
| C | packmem 0.1.1 (pickle) | 642 | same | 564 | +325 | +371 (E0) | 0 | 589 | 0.10 | 0.77 |  | 4 |
| V2S | v2 share() /dev/shm | 649 | 958 | 572 | +333 | +379 (E0v2) | 0 | 595 | 0.11 | 0.75 | 136 B | 4 |
| V2D | v2 share(dir=disk) | 650 | same | 573 | +333 | +379 (E0v2) | 0 | 595 | 0.10 | 0.76 | 164 B | 4 |
| V2O | v2 open(saved) | 549 | same | 197 | -42 | +4 (E0v2) | 0 | 245 | 0.03 | 0.44 | 134 B | 4 |
| E | floor (venv 0.1.1) | 358 | same | 239 |  |  | 0 | 327 | 0.04 | 0.56 |  | 4 |
| E2 | floor (venv v2) | 358 | same | 239 |  |  | 0 | 327 | 0.05 | 0.55 |  | 4 |
| E0 | floor, no datasets/pyarrow (venv 0.1.1) | 270 | same | 193 |  |  | 0 | 228 | 0.07 | 0.49 |  | 4 |
| E0v2 | floor, no datasets/pyarrow (venv v2) | 270 | same | 193 |  |  | 0 | 228 | 0.05 | 0.49 |  | 4 |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| A | 120 | 724 | 120 | 721-722 |
| B1 | 50-55 | 205-206 | 12 | 53-54 |
| C | 11 | 115-154 | 11 | 112-151 |
| V2S | 11-12 | 117 | 11-12 | 114 |
| V2D | 11-13 | 117-189 | 11-12 | 114-185 |
| V2O | 24-27 | 109-111 | 9 | 39-40 |
| E | 6 | 49-58 | 6 | 47-55 |
| E2 | 6 | 49-50 | 6 | 47-48 |
| E0 | 8 | 41 | 8 | 38 |
| E0v2 | 8 | 41 | 8 | 38-39 |

| Arm | file | worker map Rss (end) | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss | worker map peak Rss |
|---|---|---|---|---|---|---|---|---|
| B1 | arrow | 406-407 | 367-368 | 38-41 | 0 | 0 | 148-150 | 406-407 |
| V2O | pkm | 175-178 | 159-161 | 15-17 | 0 | 0 | 67-69 | 175-178 |

### forkserver

| Arm |  | node peak PSS sum | node peak incl. whole tmpfs file | node peak Pss_Anon sum | anon above E floor | anon above import-matched floor | node peak Pss_Shmem | parent peak USS | first batch s | 20k epoch s | pickled to each worker | workers seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | list | 16,228 | same | 16,150 | +15,310 | +15,366 (E0) | 0 | 3,808 | 81.34 | 84.48 | 687.4 MB | 4 |
| B1 | HF Arrow mmap | 1,810 | same | 1,083 | +243 | +243 (E) | 0 | 379 | 1.89 | 2.80 | 2,230 B | 4 |
| C | packmem 0.1.1 (pickle) | 2,667 | same | 2,589 | +1,749 | +1,804 (E0) | 0 | 897 | 8.35 | 9.10 | 308.0 MB | 4 |
| V2S | v2 share() /dev/shm | 1,509 | 1,543 | 1,156 | +315 | +371 (E0v2) | 275 | 594 | 1.21 | 1.70 | 136 B | 4 |
| V2D | v2 share(dir=disk) | 1,510 | same | 1,157 | +316 | +372 (E0v2) | 0 | 595 | 1.45 | 2.08 | 164 B | 4 |
| V2O | v2 open(saved) | 1,144 | same | 790 | -50 | +5 (E0v2) | 0 | 245 | 1.33 | 1.95 | 134 B | 4 |
| E | floor (venv 0.1.1) | 961 | same | 840 |  |  | 0 | 327 | 1.31 | 1.88 | 151 B | 4 |
| E2 | floor (venv v2) | 961 | same | 840 |  |  | 0 | 327 | 1.41 | 1.96 | 151 B | 4 |
| E0 | floor, no datasets/pyarrow (venv 0.1.1) | 863 | same | 785 |  |  | 0 | 228 | 1.50 | 2.04 | 151 B | 4 |
| E0v2 | floor, no datasets/pyarrow (venv v2) | 863 | same | 785 |  |  | 0 | 228 | 1.42 | 1.97 | 151 B | 4 |

| Arm | worker peak USS | worker peak PSS | worker peak Private_Dirty | worker peak Pss_Anon |
|---|---|---|---|---|
| A | 3,026-3,293 | 3,041-3,307 | 3,026-3,293 | 3,026-3,293 |
| B1 | 251-256 | 385-387 | 213 | 213 |
| C | 463-465 | 478-497 | 463 | 463 |
| V2S | 170-178 | 238-240 | 170-178 | 155 |
| V2D | 170-172 | 238-240 | 156-172 | 155 |
| V2O | 170-172 | 237-239 | 155 | 155 |
| E | 154 | 169 | 154 | 154 |
| E2 | 154 | 169 | 154 | 154 |
| E0 | 154 | 169 | 154 | 154 |
| E0v2 | 154 | 169 | 154 | 154 |

| Arm | file | worker map Rss (end) | Shared_Clean | Private_Clean | Shared_Dirty | Private_Dirty | map Pss | worker map peak Rss |
|---|---|---|---|---|---|---|---|---|
| B1 | arrow | 407-408 | 367-369 | 38-41 | 0 | 0 | 148-150 | 407-408 |
| V2S | pkm | 175-178 | 0 | 0 | 160-161 | 15-17 | 68-70 | 175-178 |
| V2D | pkm | 175-178 | 0-161 | 0-17 | 0-161 | 0-17 | 68-70 | 175-178 |
| V2O | pkm | 175-178 | 160-161 | 15-17 | 0 | 0 | 67-69 | 175-178 |

### Per-row access, one process (s, median of 3; us/op in parentheses)

| Op | B1 | C | V2O |
|---|---|---|---|
| 100k random x[i] -> dict | 3.753 (37.53) | 0.931 (9.31) | 0.938 (9.38) |
| 20k random x[i]['conversations'] | 0.818 (40.90) | 0.173 (8.64) | 0.185 (9.26) |
| 2,000 random x[i:i+64] (per row) | 0.575 (4.49) | 1.013 (7.92) | 0.964 (7.53) |
| full pass (per row) | 14.593 (21.94) | 8.385 (12.60) | 8.406 (12.64) |
| pickle bytes | 2,197 | 308,008,240 | 101 |
| mem after pass Pss_Anon MB | 103 | 382 | 29 |
| mem after pass USS MB | 903 | 383 | 339 |
| mem after pass Rss MB | 916 | 394 | 350 |

- HF/C random row to dict: 4.03x; ['conversations']: 4.73x; full pass: 1.74x
- HF/V2O random row to dict: 4.00x; ['conversations']: 4.42x; full pass: 1.74x

### Shared / saved files

- V2S/fork: tmpfs /dev/shm/, size 308,680,442 B, mode 0o600, share_s 0.153, exists at end of run (before exit): [True, True, True]
- V2S/forkserver: tmpfs /dev/shm/, size 308,680,442 B, mode 0o600, share_s 0.166, exists at end of run (before exit): [True, True, True]
- V2D/fork: disk $WORK/pkmshare/, size 308,680,442 B, mode 0o600, share_s 0.255, exists at end of run (before exit): [True, True, True]
- V2D/forkserver: disk $WORK/pkmshare/, size 308,680,442 B, mode 0o600, share_s 0.249, exists at end of run (before exit): [True, True, True]
- V2O/fork: disk $WORK/pkm/, size 308,680,442 B, mode 0o664, share_s 0.003, exists at end of run (before exit): [True, True, True]
- V2O/forkserver: disk $WORK/pkm/, size 308,680,442 B, mode 0o664, share_s 0.003, exists at end of run (before exit): [True, True, True]

Distinct batch digests across data arms: 1
- debc56792e4b2a2eb457fa213fddff123f3639c962b60c6acd2e59bd6578714f: 36 runs (A/fork, A/forkserver, B1/fork, B1/forkserver, C/fork, C/forkserver, V2D/fork, V2D/forkserver, V2O/fork, V2O/forkserver, V2S/fork, V2S/forkserver)

### Loads

- phase `prep` started 2026-11-14T00:30:12+01:00
- prep_ids [venv]: rc=0 load 29.52 -> 28.89, wall 31.4 s, avail 98 GB, /dev/shm pkm 0->0
- conv_B1 [venv]: rc=0 load 28.89 -> 29.96, wall 17.9 s, avail 102 GB, /dev/shm pkm 0->0
- hash_B1 [venv]: rc=0 load 29.96 -> 31.8, wall 26.6 s, avail 102 GB, /dev/shm pkm 0->0
- prep_v2save [venv2]: rc=0 load 31.8 -> 33.96, wall 40.3 s, avail 96 GB, /dev/shm pkm 0->0
- hash_C_v2 [venv2]: rc=0 load 33.96 -> 33.89, wall 42.9 s, avail 95 GB, /dev/shm pkm 0->0
- hash_V2O [venv2]: rc=0 load 33.89 -> 33.49, wall 31.3 s, avail 93 GB, /dev/shm pkm 0->0
- hash_C [venv]: rc=0 load 33.49 -> 36.39, wall 42.8 s, avail 100 GB, /dev/shm pkm 0->0
- smoke_V2S_forkserver [venv2]: rc=0 load 35.4 -> 33.71, wall 15.2 s, avail 103 GB, /dev/shm pkm 0->0
- phase `dl` started 2026-11-14T00:34:43+01:00
- dl_A_fork_1 [venv]: rc=0 load 32.54 -> 33.35, wall 22.8 s, avail 101 GB, /dev/shm pkm 0->0
- dl_B1_fork_1 [venv]: rc=0 load 33.35 -> 32.76, wall 5.5 s, avail 100 GB, /dev/shm pkm 0->0
- dl_C_fork_1 [venv]: rc=0 load 32.76 -> 31.12, wall 14.8 s, avail 101 GB, /dev/shm pkm 0->0
- dl_E_fork_1 [venv]: rc=0 load 31.12 -> 69.39, wall 4.2 s, avail 102 GB, /dev/shm pkm 0->0
- dl_V2S_fork_1 [venv2]: rc=0 load 69.39 -> 61.47, wall 13.8 s, avail 102 GB, /dev/shm pkm 0->0
- dl_V2D_fork_1 [venv2]: rc=0 load 61.47 -> 52.67, wall 13.3 s, avail 101 GB, /dev/shm pkm 0->0
- dl_V2O_fork_1 [venv2]: rc=0 load 52.67 -> 52.67, wall 3.4 s, avail 98 GB, /dev/shm pkm 0->0
- dl_E2_fork_1 [venv2]: rc=0 load 52.67 -> 51.26, wall 4.2 s, avail 97 GB, /dev/shm pkm 0->0
- dl_A_forkserver_1 [venv]: rc=0 load 51.26 -> 32.28, wall 92.6 s, avail 99 GB, /dev/shm pkm 0->0
- dl_B1_forkserver_1 [venv]: rc=0 load 32.28 -> 31.78, wall 6.7 s, avail 101 GB, /dev/shm pkm 0->0
- dl_C_forkserver_1 [venv]: rc=0 load 31.78 -> 29.1, wall 24.6 s, avail 101 GB, /dev/shm pkm 0->0
- dl_E_forkserver_1 [venv]: rc=0 load 29.1 -> 28.61, wall 5.4 s, avail 102 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_1 [venv2]: rc=0 load 28.61 -> 27.28, wall 12.3 s, avail 100 GB, /dev/shm pkm 0->0
- dl_V2D_forkserver_1 [venv2]: rc=0 load 27.28 -> 26.7, wall 15.3 s, avail 96 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_1 [venv2]: rc=0 load 26.7 -> 26.88, wall 5.6 s, avail 102 GB, /dev/shm pkm 0->0
- dl_E2_forkserver_1 [venv2]: rc=0 load 26.88 -> 26.25, wall 6.3 s, avail 101 GB, /dev/shm pkm 0->0
- dl_A_fork_2 [venv]: rc=0 load 26.25 -> 28.0, wall 22.5 s, avail 99 GB, /dev/shm pkm 0->0
- dl_B1_fork_2 [venv]: rc=0 load 28.0 -> 28.24, wall 5.8 s, avail 93 GB, /dev/shm pkm 0->0
- dl_C_fork_2 [venv]: rc=0 load 28.24 -> 26.98, wall 15.8 s, avail 98 GB, /dev/shm pkm 0->0
- dl_E_fork_2 [venv]: rc=0 load 26.98 -> 26.9, wall 4.6 s, avail 100 GB, /dev/shm pkm 0->0
- dl_V2S_fork_2 [venv2]: rc=0 load 26.9 -> 26.6, wall 13.4 s, avail 97 GB, /dev/shm pkm 0->0
- dl_V2D_fork_2 [venv2]: rc=0 load 26.6 -> 28.87, wall 14.7 s, avail 102 GB, /dev/shm pkm 0->0
- dl_V2O_fork_2 [venv2]: rc=0 load 28.87 -> 27.36, wall 3.1 s, avail 105 GB, /dev/shm pkm 0->0
- dl_E2_fork_2 [venv2]: rc=0 load 27.36 -> 26.69, wall 4.1 s, avail 104 GB, /dev/shm pkm 0->0
- dl_A_forkserver_2 [venv]: rc=0 load 26.69 -> 31.6, wall 117.6 s, avail 105 GB, /dev/shm pkm 0->0
- dl_B1_forkserver_2 [venv]: rc=0 load 31.6 -> 32.9, wall 8.2 s, avail 101 GB, /dev/shm pkm 0->0
- dl_C_forkserver_2 [venv]: rc=0 load 32.9 -> 29.91, wall 27.9 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E_forkserver_2 [venv]: rc=0 load 29.91 -> 30.24, wall 5.9 s, avail 100 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_2 [venv2]: rc=0 load 30.24 -> 29.63, wall 17.2 s, avail 101 GB, /dev/shm pkm 0->0
- dl_V2D_forkserver_2 [venv2]: rc=0 load 29.63 -> 28.73, wall 15.7 s, avail 104 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_2 [venv2]: rc=0 load 28.73 -> 29.79, wall 5.7 s, avail 104 GB, /dev/shm pkm 0->0
- dl_E2_forkserver_2 [venv2]: rc=0 load 29.79 -> 30.85, wall 7.2 s, avail 101 GB, /dev/shm pkm 0->0
- dl_A_fork_3 [venv]: rc=0 load 30.85 -> 30.81, wall 25.9 s, avail 96 GB, /dev/shm pkm 0->0
- dl_B1_fork_3 [venv]: rc=0 load 30.81 -> 32.33, wall 7.5 s, avail 99 GB, /dev/shm pkm 0->0
- dl_C_fork_3 [venv]: rc=0 load 32.33 -> 35.95, wall 20.8 s, avail 96 GB, /dev/shm pkm 0->0
- dl_E_fork_3 [venv]: rc=0 load 35.95 -> 36.11, wall 6.4 s, avail 99 GB, /dev/shm pkm 0->0
- dl_V2S_fork_3 [venv2]: rc=0 load 36.11 -> 39.43, wall 18.3 s, avail 95 GB, /dev/shm pkm 0->0
- dl_V2D_fork_3 [venv2]: rc=0 load 39.43 -> 38.24, wall 17.9 s, avail 98 GB, /dev/shm pkm 0->0
- dl_V2O_fork_3 [venv2]: rc=0 load 37.42 -> 37.42, wall 4.6 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E2_fork_3 [venv2]: rc=0 load 37.42 -> 37.04, wall 5.4 s, avail 101 GB, /dev/shm pkm 0->0
- dl_A_forkserver_3 [venv]: rc=0 load 37.04 -> 33.79, wall 122.6 s, avail 97 GB, /dev/shm pkm 0->0
- dl_B1_forkserver_3 [venv]: rc=0 load 33.79 -> 34.53, wall 9.2 s, avail 96 GB, /dev/shm pkm 0->0
- dl_C_forkserver_3 [venv]: rc=0 load 34.53 -> 34.82, wall 28.0 s, avail 98 GB, /dev/shm pkm 0->0
- dl_E_forkserver_3 [venv]: rc=0 load 34.82 -> 35.0, wall 6.0 s, avail 103 GB, /dev/shm pkm 0->0
- dl_V2S_forkserver_3 [venv2]: rc=0 load 35.0 -> 34.63, wall 16.8 s, avail 100 GB, /dev/shm pkm 0->0
- dl_V2D_forkserver_3 [venv2]: rc=0 load 34.63 -> 36.18, wall 17.4 s, avail 101 GB, /dev/shm pkm 0->0
- dl_V2O_forkserver_3 [venv2]: rc=0 load 36.18 -> 35.77, wall 5.6 s, avail 99 GB, /dev/shm pkm 0->0
- dl_E2_forkserver_3 [venv2]: rc=0 load 35.77 -> 35.06, wall 6.4 s, avail 101 GB, /dev/shm pkm 0->0
- phase `floor0` started 2026-11-14T00:49:57+01:00
- dl_E0_fork_1 [venv]: rc=0 load 34.11 -> 34.5, wall 4.3 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E0v2_fork_1 [venv2]: rc=0 load 34.5 -> 35.1, wall 4.3 s, avail 94 GB, /dev/shm pkm 0->0
- dl_E0_forkserver_1 [venv]: rc=0 load 35.1 -> 34.85, wall 5.7 s, avail 98 GB, /dev/shm pkm 0->0
- dl_E0v2_forkserver_1 [venv2]: rc=0 load 34.85 -> 33.9, wall 5.8 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E0_fork_2 [venv]: rc=0 load 33.9 -> 33.27, wall 4.2 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E0v2_fork_2 [venv2]: rc=0 load 33.27 -> 34.45, wall 3.7 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E0_forkserver_2 [venv]: rc=0 load 34.45 -> 34.17, wall 5.5 s, avail 99 GB, /dev/shm pkm 0->0
- dl_E0v2_forkserver_2 [venv2]: rc=0 load 34.17 -> 33.44, wall 5.0 s, avail 97 GB, /dev/shm pkm 0->0
- dl_E0_fork_3 [venv]: rc=0 load 33.44 -> 33.56, wall 3.5 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E0v2_fork_3 [venv2]: rc=0 load 33.56 -> 33.56, wall 3.5 s, avail 98 GB, /dev/shm pkm 0->0
- dl_E0_forkserver_3 [venv]: rc=0 load 33.56 -> 32.24, wall 4.9 s, avail 100 GB, /dev/shm pkm 0->0
- dl_E0v2_forkserver_3 [venv2]: rc=0 load 32.24 -> 31.9, wall 5.2 s, avail 98 GB, /dev/shm pkm 0->0
- phase `access` started 2026-11-14T00:50:53+01:00
- full_B1warm_1 [venv]: rc=0 load 31.51 -> 31.92, wall 28.0 s, avail 99 GB, /dev/shm pkm 0->0
- full_C_1 [venv]: rc=0 load 31.92 -> 31.19, wall 30.6 s, avail 101 GB, /dev/shm pkm 0->0
- full_V2O_1 [venv2]: rc=0 load 31.19 -> 33.47, wall 16.6 s, avail 102 GB, /dev/shm pkm 0->0
- full_B1warm_2 [venv]: rc=0 load 33.47 -> 34.52, wall 24.0 s, avail 96 GB, /dev/shm pkm 0->0
- full_C_2 [venv]: rc=0 load 34.52 -> 35.31, wall 27.0 s, avail 98 GB, /dev/shm pkm 0->0
- full_V2O_2 [venv2]: rc=0 load 35.31 -> 36.21, wall 15.3 s, avail 98 GB, /dev/shm pkm 0->0
- full_B1warm_3 [venv]: rc=0 load 36.21 -> 37.72, wall 27.0 s, avail 94 GB, /dev/shm pkm 0->0
- full_C_3 [venv]: rc=0 load 37.72 -> 36.88, wall 30.6 s, avail 97 GB, /dev/shm pkm 0->0
- full_V2O_3 [venv2]: rc=0 load 36.88 -> 33.93, wall 14.0 s, avail 99 GB, /dev/shm pkm 0->0
