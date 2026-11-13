## Load / reload time (s, median of 3)

| Arm | load_s | id normalize_s | runs |
|---|---|---|---|
| A | 4.59 | 0.13 | 4.57 / 4.59 / 6.32 |
| B1 warm | 0.02 | 0.00 | 0.02 / 0.02 / 0.03 |
| B1 cold | 0.19 | 0.00 | 0.19 / 0.19 / 0.24 |
| B2 | 0.18 | 0.00 | 0.15 / 0.18 / 0.34 |
| B3 | 0.02 | 0.00 | 0.02 / 0.02 / 0.03 |
| C | 8.46 | 0.18 | 8.43 / 8.46 / 15.33 |
| B1 first conversion | 25.15 |  | 25.06 / 25.15 / 27.00 |
| B3 first conversion (from parquet) | 2.28 |  | 2.26 / 2.28 / 2.32 |

## Memory after load and after full pass (MB = 10^6 B, median of 3)

### mem_after_load

| Arm | Rss | Pss | USS | Priv_Dirty | Priv_Clean | Shared_Clean | Pss_Anon | Pss_File | arrow Rss | arrow Private | peak RSS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 2,906 | 2,898 | 2,895 | 2,895 | 0 | 10 | 2,895 | 3 | 0 | 0 | 3,930 |
| B1 warm | 197 | 187 | 184 | 89 | 95 | 13 | 89 | 98 | 44 | 44 | 195 |
| B1 cold | 197 | 187 | 184 | 89 | 95 | 13 | 89 | 98 | 44 | 44 | 195 |
| B2 | 1,021 | 1,011 | 1,009 | 958 | 51 | 13 | 958 | 54 | 0 | 0 | 1,019 |
| B3 | 197 | 187 | 184 | 89 | 95 | 13 | 89 | 98 | 44 | 44 | 194 |
| C | 385 | 377 | 375 | 373 | 1 | 11 | 373 | 4 | 0 | 0 | 451 |

### mem_after_pass

| Arm | Rss | Pss | USS | Priv_Dirty | Priv_Clean | Shared_Clean | Pss_Anon | Pss_File | arrow Rss | arrow Private | peak RSS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 2,908 | 2,900 | 2,898 | 2,898 | 0 | 10 | 2,898 | 3 | 0 | 0 | 3,930 |
| B1 warm | 915 | 905 | 903 | 102 | 801 | 13 | 102 | 804 | 749 | 749 | 936 |
| B1 cold | 913 | 903 | 900 | 102 | 799 | 13 | 102 | 802 | 747 | 747 | 930 |
| B2 | 1,036 | 1,025 | 1,023 | 971 | 52 | 13 | 971 | 55 | 0 | 0 | 1,055 |
| B3 | 915 | 905 | 902 | 101 | 801 | 13 | 101 | 804 | 749 | 749 | 934 |
| C | 394 | 386 | 383 | 382 | 1 | 11 | 382 | 4 | 0 | 0 | 460 |

## Access (s, median of 3)

| Op | A | B1 warm | B1 cold | B2 | B3 | C |
|---|---|---|---|---|---|---|
| 100k random x[i] | 0.015 | 2.216 | 2.738 | 2.350 | 2.652 | 0.605 |
| 20k random x[i]['conversations'] | 0.005 | 0.420 | 0.465 | 0.460 | 0.523 | 0.122 |
| 2,000 random x[i:i+64] | 0.001 | 0.288 | 0.351 | 0.310 | 0.365 | 0.635 |
| full pass, conv[0]['value'] | 0.166 | 10.168 | 10.298 | 11.420 | 10.681 | 3.754 |
| packmem 100k rows_lazy(i,i+1) |  |  |  |  |  | 0.021 |
| packmem 20k lazy ['conversations'] |  |  |  |  |  | 0.164 |
| packmem lazy() pass |  |  |  |  |  | 2.771 |
| HF ds.iter(1000) pass |  | 1.992 | 2.136 | 2.688 | 1.922 |  |
| pickle dumps | 7.455 | 0.000 | 0.000 |  | 0.000 | 0.409 |
| pickle loads | 2.667 | 0.008 | 0.010 |  | 0.012 | 0.313 |
| pickle MB | 687.4 | 0.0 | 0.0 |  | 0.0 | 308.0 |

## Per-op microseconds (median)

| Op (us) | A | B1 warm | B1 cold | B2 | B3 | C |
|---|---|---|---|---|---|---|
| x[i] -> dict | 0.15 | 22.16 | 27.38 | 23.50 | 26.52 | 6.05 |
| x[i]['conversations'] | 0.27 | 21.01 | 23.25 | 22.98 | 26.16 | 6.08 |
| per row via x[i:i+64] | 0.01 | 2.25 | 2.74 | 2.42 | 2.85 | 4.96 |
| per row, sequential | 0.25 | 15.28 | 15.48 | 17.17 | 16.05 | 5.64 |

## DataLoader (4 workers, batch 8, 20k random indices; MB, median of 3)

| Arm | start | peak PSS sum | peak USS sum | peak Pss_Anon sum | parent peak USS | worker peak USS | worker peak Priv_Dirty | worker peak arrow Rss | first batch s | 20k epoch s | pickled MB | workers seen |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | fork | 3,604 | 3,115 | 3,528 | 3,115 | 119-121 | 119-121 | 0-0 | 0.20 | 0.94 |  | 4 |
| B1 | fork | 994 | 378 | 269 | 378 | 50-53 | 12-12 | 406-407 | 0.02 | 0.35 |  | 4 |
| C | fork | 641 | 589 | 564 | 589 | 11-11 | 11-11 | 0-0 | 0.04 | 0.25 |  | 4 |
| E | fork | 358 | 327 | 239 | 327 | 6-6 | 6-6 | 0-0 | 0.02 | 0.20 |  | 4 |
| A | forkserver | 15,725 | 15,648 | 15,647 | 3,813 | 3,026-3,293 | 3,026-3,293 | 0-0 | 38.63 | 39.50 | 687.450 | 4 |
| B1 | forkserver | 1,811 | 1,240 | 1,083 | 378 | 251-253 | 213-213 | 406-408 | 1.08 | 1.40 | 0.002 | 4 |
| C | forkserver | 2,762 | 2,684 | 2,683 | 897 | 463-769 | 463-769 | 0-0 | 4.83 | 5.09 | 308.008 | 4 |
| E | forkserver | 961 | 883 | 840 | 327 | 154-154 | 154-154 | 0-0 | 0.76 | 0.91 | 0.000 | 4 |

Distinct batch digests across A/B1/C DataLoader runs: 1 ['debc56792e4b2a2eb457fa213fddff123f3639c962b60c6acd2e59bd6578714f']

## Loads

- conv_B0_origfile: rc=0 load 33.18 -> 29.78, wall 46.9 s, avail 97 GB
- hash_A: rc=0 load 29.34 -> 26.56, wall 26.2 s, avail 101 GB
- hash_C: rc=0 load 26.56 -> 26.38, wall 42.2 s, avail 102 GB
- hash_B0_origfile: rc=0 load 26.38 -> 24.67, wall 23.6 s, avail 97 GB
- diff_B0_origfile: rc=0 load 23.53 -> 23.0, wall 21.6 s, avail 103 GB
- try_mixed_none: rc=0 load 25.23 -> 26.9, wall 31.6 s, avail 103 GB
- prep_ids: rc=0 load 26.68 -> 37.66, wall 38.0 s, avail 97 GB
- conv_B1_1: rc=0 load 38.33 -> 41.23, wall 26.9 s, avail 93 GB
- conv_B1_2: rc=0 load 41.23 -> 40.97, wall 26.8 s, avail 95 GB
- conv_B1_3: rc=0 load 40.97 -> 41.11, wall 28.6 s, avail 93 GB
- hash_B1: rc=0 load 41.11 -> 46.9, wall 33.4 s, avail 90 GB
- conv_B4: rc=0 load 46.48 -> 43.7, wall 87.7 s, avail 88 GB
- mkparquet: rc=0 load 42.48 -> 43.49, wall 6.6 s, avail 96 GB
- conv_B3_1: rc=0 load 43.49 -> 43.37, wall 3.7 s, avail 95 GB
- conv_B3_2: rc=0 load 43.37 -> 43.37, wall 3.7 s, avail 96 GB
- conv_B3_3: rc=0 load 43.37 -> 45.1, wall 3.6 s, avail 97 GB
- hash_B3: rc=0 load 45.1 -> 43.03, wall 28.7 s, avail 96 GB
- size_A: rc=0 load 46.27 -> 45.48, wall 58.6 s, avail 94 GB
- full_A_1: rc=0 load 45.2 -> 44.97, wall 48.8 s, avail 94 GB
- full_C_1: rc=0 load 44.97 -> 45.63, wall 41.0 s, avail 95 GB
- full_B1warm_1: rc=0 load 45.63 -> 42.46, wall 28.0 s, avail 98 GB
- full_B1cold_1: rc=0 load 42.46 -> 37.08, wall 24.8 s, avail 100 GB
- full_B2_1: rc=0 load 37.08 -> 35.88, wall 22.7 s, avail 106 GB
- full_B3_1: rc=0 load 35.88 -> 32.79, wall 20.6 s, avail 105 GB
- full_A_2: rc=0 load 32.79 -> 27.75, wall 29.5 s, avail 104 GB
- full_C_2: rc=0 load 27.75 -> 23.8, wall 21.8 s, avail 104 GB
- full_B1warm_2: rc=0 load 23.74 -> 23.24, wall 19.4 s, avail 106 GB
- full_B1cold_2: rc=0 load 23.24 -> 22.35, wall 21.6 s, avail 104 GB
- full_B2_2: rc=0 load 22.35 -> 22.63, wall 24.6 s, avail 104 GB
- full_B3_2: rc=0 load 22.63 -> 22.14, wall 21.6 s, avail 103 GB
- full_A_3: rc=0 load 22.14 -> 22.12, wall 31.0 s, avail 104 GB
- full_C_3: rc=0 load 22.12 -> 22.61, wall 23.8 s, avail 102 GB
- full_B1warm_3: rc=0 load 22.61 -> 20.76, wall 20.3 s, avail 102 GB
- full_B1cold_3: rc=0 load 20.76 -> 22.02, wall 22.2 s, avail 100 GB
- full_B2_3: rc=0 load 22.02 -> 20.92, wall 20.5 s, avail 105 GB
- full_B3_3: rc=0 load 20.92 -> 21.16, wall 20.0 s, avail 105 GB
- dl_A_fork_1: rc=0 load 13.7 -> 13.49, wall 13.5 s, avail 107 GB
- dl_B1_fork_1: rc=0 load 13.49 -> 12.97, wall 3.4 s, avail 107 GB
- dl_C_fork_1: rc=0 load 12.97 -> 12.26, wall 12.8 s, avail 109 GB
- dl_E_fork_1: rc=0 load 12.26 -> 11.84, wall 2.7 s, avail 110 GB
- dl_A_forkserver_1: rc=0 load 11.84 -> 8.34, wall 63.5 s, avail 110 GB
- dl_B1_forkserver_1: rc=0 load 8.34 -> 8.34, wall 3.5 s, avail 114 GB
- dl_C_forkserver_1: rc=0 load 8.34 -> 8.96, wall 15.7 s, avail 114 GB
- dl_E_forkserver_1: rc=0 load 8.96 -> 8.96, wall 2.8 s, avail 113 GB
- dl_A_fork_2: rc=0 load 8.96 -> 7.81, wall 10.6 s, avail 114 GB
- dl_B1_fork_2: rc=0 load 7.81 -> 7.43, wall 2.7 s, avail 112 GB
- dl_C_fork_2: rc=0 load 7.43 -> 6.96, wall 11.0 s, avail 113 GB
- dl_E_fork_2: rc=0 load 6.96 -> 7.12, wall 2.4 s, avail 113 GB
- dl_A_forkserver_2: rc=0 load 7.12 -> 4.74, wall 55.7 s, avail 114 GB
- dl_B1_forkserver_2: rc=0 load 4.74 -> 4.74, wall 3.7 s, avail 112 GB
- dl_C_forkserver_2: rc=0 load 4.74 -> 3.68, wall 15.8 s, avail 113 GB
- dl_E_forkserver_2: rc=0 load 3.68 -> 3.68, wall 3.0 s, avail 112 GB
- dl_A_fork_3: rc=0 load 3.68 -> 3.43, wall 10.2 s, avail 113 GB
- dl_B1_fork_3: rc=0 load 3.43 -> 3.55, wall 2.4 s, avail 114 GB
- dl_C_fork_3: rc=0 load 3.55 -> 3.24, wall 10.4 s, avail 114 GB
- dl_E_fork_3: rc=0 load 3.24 -> 3.24, wall 2.2 s, avail 114 GB
- dl_A_forkserver_3: rc=0 load 3.24 -> 2.65, wall 55.2 s, avail 114 GB
- dl_B1_forkserver_3: rc=0 load 2.65 -> 2.6, wall 3.6 s, avail 111 GB
- dl_C_forkserver_3: rc=0 load 2.6 -> 3.8, wall 16.1 s, avail 113 GB
- dl_E_forkserver_3: rc=0 load 3.8 -> 3.58, wall 3.0 s, avail 112 GB
- size_A: rc=0 load 3.58 -> 3.01, wall 22.1 s, avail 113 GB
- full_A_1: rc=0 load 3.01 -> 3.22, wall 20.3 s, avail 114 GB
- full_C_1: rc=0 load 3.22 -> 3.42, wall 17.7 s, avail 113 GB
- full_B1warm_1: rc=0 load 3.42 -> 4.73, wall 15.7 s, avail 111 GB
- full_B1cold_1: rc=0 load 4.73 -> 4.06, wall 15.4 s, avail 111 GB
- full_B2_1: rc=0 load 4.06 -> 3.92, wall 14.8 s, avail 113 GB
- full_B3_1: rc=0 load 3.92 -> 3.78, wall 14.9 s, avail 113 GB
- full_A_2: rc=0 load 3.78 -> 3.05, wall 19.3 s, avail 113 GB
- full_C_2: rc=0 load 3.05 -> 2.97, wall 16.9 s, avail 112 GB
- full_B1warm_2: rc=0 load 2.97 -> 3.57, wall 15.6 s, avail 113 GB
- full_B1cold_2: rc=0 load 3.57 -> 4.42, wall 17.3 s, avail 112 GB
- full_B2_2: rc=0 load 4.42 -> 6.23, wall 18.1 s, avail 108 GB
- full_B3_2: rc=0 load 6.85 -> 8.92, wall 17.2 s, avail 110 GB
- full_A_3: rc=0 load 8.92 -> 15.17, wall 30.1 s, avail 104 GB
- full_C_3: rc=0 load 15.17 -> 29.45, wall 35.0 s, avail 100 GB
- full_B1warm_3: rc=0 load 29.45 -> 37.76, wall 27.5 s, avail 88 GB
- full_B1cold_3: rc=0 load 37.76 -> 41.1, wall 30.7 s, avail 92 GB
- full_B2_3: rc=0 load 41.1 -> 38.13, wall 25.0 s, avail 94 GB
- full_B3_3: rc=0 load 38.13 -> 33.25, wall 25.4 s, avail 93 GB
