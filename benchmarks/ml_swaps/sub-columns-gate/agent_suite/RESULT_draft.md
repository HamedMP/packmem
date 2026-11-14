## Suite 1a: holders of real agent datasets

| dataset | licence | records | source MB | derivation |
|---|---|---|---|---|
| hermes_fc | apache-2.0 | 11578 | 66.7 | the five JSON arrays (one per Hub config) concatenated as JSON lines; records unchanged |
| glaive_fc | apache-2.0 | 112960 | 268.0 | the JSON array as JSON lines; records unchanged |
| swe_smith | mit | 3013 | 823.8 | first shard of the `tool` split; the `messages` column (published as JSON text) decoded, so each record holds its OpenAI-format message list |
| swe_rebench | cc-by-4.0 | 4000 | 1,129.6 | first 4000 rows; inside `trajectory` messages and their tool calls, keys whose value is null are dropped, as the OpenAI wire format writes them (tool_calls only on assistant turns, tool_call_id/name only on tool turns) |
| swe_rebench_pq | cc-by-4.0 | 4000 | 157.0 | the same first 4000 rows, rewritten as a zstd parquet file with the published schema |
| mind2web | cc-by-4.0 | 200 | 565.2 | train shards 0-1; `raw_html` dropped from every action (cleaned_html, operation and the positive/negative DOM candidates kept) |
| agentnet | mit | 5000 | 282.3 | the Ubuntu file as published (screenshots are file names; image archives not downloaded) |
| gui_odyssey | cc-by-4.0 | 7735 | 33.7 | all_anno.json with `steps` and `app` (published as Python-literal text) parsed with ast.literal_eval, giving the per-step structure of the per-episode annotation files |

### Size (MB)

| dataset | source | list tracemalloc | list Pss_Anon settled | HF Arrow cache | HF Pss_Anon | pm 0.2.0 nbytes | pm 0.2.0 file | pm main nbytes | pm main file | pm main compact nbytes | compact file |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hermes_fc | 66.7 | 90.0 | 94.8 |  |  | 33.4 | 33.4 | 32.9 | 32.9 | 27.1 | 27.1 |
| glaive_fc | 268.0 | 302.7 | 320.6 | 254.5 | 2.6 | 122.9 | 122.9 | 122.9 | 122.9 | 59.0 | 59.0 |
| swe_smith | 823.8 | 2,189.5 | 2,439.7 | 808.6 | 2.6 | 505.4 | 505.4 | 500.2 | 500.1 | 378.5 | 378.5 |
| swe_rebench | 1,129.6 | 1,695.5 | 1,759.3 | 1,132.2 | 3.5 | 555.8 | 555.8 | 578.3 | 578.3 | 193.4 | 193.4 |
| swe_rebench_pq | 157.0 | 1,720.9 | 4,171.5 | 1,066.8 | 5.4 | 587.0 | 587.0 | 578.4 | 578.4 | 221.7 | 221.7 |
| mind2web | 565.2 | 782.0 | 857.0 | 494.5 | 3.0 | 198.4 | 198.4 | 161.9 | 161.9 | 61.6 | 61.6 |
| agentnet | 282.3 | 381.6 | 394.4 | 281.4 | 2.6 | 152.1 | 152.1 | 138.0 | 138.0 | 137.2 | 137.2 |
| gui_odyssey | 33.7 | 103.9 | 112.0 | 27.7 | 2.5 | 11.4 | 11.4 | 10.5 | 10.5 | 7.2 | 7.2 |

### Load / build time (s, median)

| dataset | list json.loads | HF build cache | HF reload | pm 0.2.0 | pm main | pm main threads=1 | pm main compact | open() 0.2.0 | open() main |
|---|---|---|---|---|---|---|---|---|---|
| hermes_fc | 0.28 |  |  | 0.50 | 0.65 | 0.54 | 0.84 | 0.000 | 0.000 |
| glaive_fc | 0.85 | 0.72 | 0.01 | 1.48 | 0.69 | 1.42 | 1.73 | 0.000 | 0.000 |
| swe_smith | 4.21 | 11.20 | 0.01 | 7.08 | 8.32 | 7.34 | 9.68 | 0.000 | 0.001 |
| swe_rebench | 5.02 | 10.82 | 0.01 | 7.59 | 8.96 | 7.83 | 9.18 | 0.000 | 0.001 |
| swe_rebench_pq | 1.96 | 0.79 | 0.01 | 10.35 | 10.59 | 10.47 | 11.02 | 0.000 | 0.001 |
| mind2web | 1.69 | 1.46 | 0.01 | 3.06 | 4.35 | 3.80 | 4.61 | 0.000 | 0.001 |
| agentnet | 0.86 | 2.38 | 0.01 | 2.17 | 2.40 | 2.11 | 3.98 | 0.000 | 0.001 |
| gui_odyssey | 0.36 | 2.21 | 0.01 | 0.18 | 0.25 | 0.22 | 0.48 | 0.000 | 0.001 |

### Faithfulness (records changed / compared; kinds of change)

| dataset | holder | ok | changed | key order differs | kinds (records, occurrences, top path) |
|---|---|---|---|---|---|
| hermes_fc | hf | load failed: datasets.exceptions.DatasetGenerationError | | | An error occurred while generating the dataset |
| hermes_fc | pm020 | yes | 0 / 11578 | 0 |  |
| hermes_fc | pmmain | yes | 0 / 11578 | 0 |  |
| hermes_fc | pmmain_t1 | yes | 0 / 11578 | 0 |  |
| hermes_fc | pmmainc | yes | 0 / 11578 | 0 |  |
| glaive_fc | hf | yes | 0 / 112960 | 0 |  |
| glaive_fc | pm020 | yes | 0 / 112960 | 0 |  |
| glaive_fc | pmmain | yes | 0 / 112960 | 0 |  |
| glaive_fc | pmmain_t1 | yes | 0 / 112960 | 0 |  |
| glaive_fc | pmmainc | yes | 0 / 112960 | 0 |  |
| swe_smith | hf | yes | 0 / 3013 | 0 |  |
| swe_smith | pm020 | yes | 0 / 3013 | 0 |  |
| swe_smith | pmmain | yes | 0 / 3013 | 0 |  |
| swe_smith | pmmain_t1 | yes | 0 / 3013 | 0 |  |
| swe_smith | pmmainc | yes | 0 / 3013 | 0 |  |
| swe_rebench | hf | yes | 0 / 4000 | 0 |  |
| swe_rebench | pm020 | yes | 0 / 4000 | 0 |  |
| swe_rebench | pmmain | yes | 0 / 4000 | 0 |  |
| swe_rebench | pmmain_t1 | yes | 0 / 4000 | 0 |  |
| swe_rebench | pmmainc | yes | 0 / 4000 | 0 |  |
| swe_rebench_pq | hf | yes | 0 / 4000 | 0 |  |
| swe_rebench_pq | pm020 | yes | 0 / 4000 | 0 |  |
| swe_rebench_pq | pmmain | yes | 0 / 4000 | 0 |  |
| swe_rebench_pq | pmmain_t1 | yes | 0 / 4000 | 0 |  |
| swe_rebench_pq | pmmainc | yes | 0 / 4000 | 0 |  |
| mind2web | hf | yes | 0 / 200 | 0 |  |
| mind2web | pm020 | yes | 0 / 200 | 0 |  |
| mind2web | pmmain | yes | 0 / 200 | 0 |  |
| mind2web | pmmain_t1 | yes | 0 / 200 | 0 |  |
| mind2web | pmmainc | yes | 0 / 200 | 0 |  |
| agentnet | hf | yes | 2331 / 5000 | 751 | key_added_none (2331, 16297, $.natural_language_task) |
| agentnet | pm020 | yes | 0 / 5000 | 751 |  |
| agentnet | pmmain | yes | 0 / 5000 | 751 |  |
| agentnet | pmmain_t1 | yes | 0 / 5000 | 751 |  |
| agentnet | pmmainc | yes | 0 / 5000 | 751 |  |
| gui_odyssey | hf | yes | 306 / 7735 | 0 | coerced:str->float (8, 8, $.steps[].info); coerced:str->int (298, 302, $.steps[].info) |
| gui_odyssey | pm020 | yes | 0 / 7735 | 0 |  |
| gui_odyssey | pmmain | yes | 0 / 7735 | 0 |  |
| gui_odyssey | pmmain_t1 | yes | 0 / 7735 | 0 |  |
| gui_odyssey | pmmainc | yes | 0 / 7735 | 0 |  |

### DataLoader, 4 workers (MB; median of repeats)


#### forkserver

| dataset | arm | node peak PSS | incl. tmpfs file | node peak Pss_Anon | anon above floor | parent peak USS | worker peak USS (max) | first batch s | epoch s | batch digest |
|---|---|---|---|---|---|---|---|---|---|---|
| hermes_fc | A | 1,367 |  | 1,289 | 506 | 416 | 249 | 3.20 | 3.38 | 15187090b9 |
| hermes_fc | V2S020 | 898 | 898 | 787 | 3 | 228 | 156 | 0.71 | 0.93 | 15187090b9 |
| hermes_fc | V2O020 | 898 |  | 786 | 3 | 227 | 156 | 0.73 | 0.95 | 15187090b9 |
| hermes_fc | V2Smain | 902 | 902 | 791 | 7 | 231 | 156 | 0.73 | 0.91 | 15187090b9 |
| hermes_fc | V2Omain | 899 |  | 787 | 4 | 228 | 156 | 0.73 | 0.92 | 15187090b9 |
| hermes_fc | E | 959 |  | 839 |  | 325 | 154 | 0.73 | 0.85 | b53519f7de |
| hermes_fc | E0 | 862 |  | 784 |  | 226 | 154 | 0.74 | 0.85 | b53519f7de |
| hermes_fc | E0main | 862 |  | 784 |  | 226 | 154 | 0.73 | 0.84 | b53519f7de |
| glaive_fc | A | 2,719 |  | 2,641 | 1,857 | 848 | 464 | 4.21 | 4.42 | e47f0bd3af |
| glaive_fc | B1 | 1,439 |  | 1,063 | 223 | 338 | 230 | 1.06 | 1.36 | e47f0bd3af |
| glaive_fc | V2S020 | 991 | 991 | 790 | 5 | 232 | 156 | 0.77 | 0.96 | e47f0bd3af |
| glaive_fc | V2O020 | 989 |  | 787 | 2 | 230 | 156 | 0.76 | 0.95 | e47f0bd3af |
| glaive_fc | V2Smain | 1,015 | 1,015 | 813 | 28 | 256 | 156 | 0.77 | 0.94 | e47f0bd3af |
| glaive_fc | V2Omain | 989 |  | 788 | 2 | 230 | 156 | 0.74 | 0.94 | e47f0bd3af |
| glaive_fc | E | 960 |  | 840 |  | 326 | 154 | 0.75 | 0.89 | 3b567fcff5 |
| glaive_fc | E0 | 863 |  | 785 |  | 228 | 154 | 0.73 | 0.88 | 3b567fcff5 |
| glaive_fc | E0main | 864 |  | 785 |  | 228 | 154 | 0.74 | 0.88 | 3b567fcff5 |
| swe_smith | A | 14,363 |  | 14,286 | 13,503 | 3,821 | 4,200 | 11.81 | 16.30 | 6e7444338a |
| swe_smith | B1 | 6,052 |  | 5,220 | 4,381 | 331 | 4,802 | 1.14 | 6.84 | 6e7444338a |
| swe_smith | V2S020 | 5,060 | 5,105 | 4,521 | 3,738 | 227 | 4,162 | 0.74 | 6.90 | 6e7444338a |
| swe_smith | V2O020 | 4,774 |  | 4,237 | 3,454 | 227 | 3,877 | 0.78 | 6.94 | 6e7444338a |
| swe_smith | V2Smain | 5,157 | 5,191 | 4,613 | 3,829 | 265 | 4,210 | 0.80 | 6.83 | 6e7444338a |
| swe_smith | V2Omain | 5,088 |  | 4,542 | 3,759 | 232 | 4,173 | 0.79 | 6.83 | 6e7444338a |
| swe_smith | E | 959 |  | 839 |  | 325 | 154 | 0.73 | 0.80 | 4a3eeb63bf |
| swe_smith | E0 | 861 |  | 783 |  | 226 | 154 | 0.75 | 0.82 | 4a3eeb63bf |
| swe_smith | E0main | 861 |  | 783 |  | 226 | 154 | 0.77 | 0.83 | 4a3eeb63bf |
| swe_rebench | A | 10,939 |  | 10,862 | 10,079 | 3,241 | 1,964 | 13.54 | 15.30 | 9c3c9136c6 |
| swe_rebench | B1 | 2,351 |  | 1,097 | 258 | 336 | 426 | 1.09 | 3.66 | 9c3c9136c6 |
| swe_rebench | V2S020 | 1,464 | 1,464 | 830 | 47 | 227 | 255 | 0.77 | 3.22 | 9c3c9136c6 |
| swe_rebench | V2O020 | 1,457 |  | 829 | 46 | 227 | 255 | 0.77 | 3.24 | 9c3c9136c6 |
| swe_rebench | V2Smain | 1,472 | 1,472 | 815 | 31 | 236 | 233 | 0.81 | 3.04 | 9c3c9136c6 |
| swe_rebench | V2Omain | 1,471 |  | 817 | 33 | 236 | 235 | 0.79 | 2.97 | 9c3c9136c6 |
| swe_rebench | E | 959 |  | 839 |  | 325 | 154 | 0.73 | 0.79 | 1ec8bb40e6 |
| swe_rebench | E0 | 862 |  | 783 |  | 226 | 154 | 0.73 | 0.80 | 1ec8bb40e6 |
| swe_rebench | E0main | 862 |  | 783 |  | 226 | 154 | 0.75 | 0.83 | 1ec8bb40e6 |
| swe_rebench_pq | A | 13,375 |  | 13,250 | 12,467 | 5,694 | 1,960 | 13.66 | 15.47 | a23b89812b |
| swe_rebench_pq | B1 | 2,292 |  | 1,104 | 266 | 335 | 368 | 1.09 | 3.27 | a23b89812b |
| swe_rebench_pq | V2S020 | 3,497 | 3,497 | 2,800 | 2,016 | 2,241 | 256 | 0.76 | 3.05 | a23b89812b |
| swe_rebench_pq | V2O020 | 1,484 |  | 819 | 36 | 227 | 257 | 0.77 | 3.04 | a23b89812b |
| swe_rebench_pq | V2Smain | 3,485 | 3,485 | 2,796 | 2,013 | 2,250 | 233 | 0.77 | 3.01 | a23b89812b |
| swe_rebench_pq | V2Omain | 1,473 |  | 816 | 33 | 236 | 233 | 0.77 | 2.99 | a23b89812b |
| swe_rebench_pq | E | 958 |  | 839 |  | 325 | 154 | 0.73 | 0.82 | 1ec8bb40e6 |
| swe_rebench_pq | E0 | 861 |  | 783 |  | 226 | 154 | 0.73 | 0.81 | 1ec8bb40e6 |
| swe_rebench_pq | E0main | 862 |  | 783 |  | 226 | 154 | 0.73 | 0.81 | 1ec8bb40e6 |
| mind2web | A | 5,005 |  | 4,927 | 4,144 | 1,575 | 991 | 9.61 | 10.24 | 253d895f18 |
| mind2web | B1 | 1,928 |  | 1,312 | 474 | 331 | 408 | 1.23 | 1.85 | 253d895f18 |
| mind2web | V2S020 | 1,398 | 1,403 | 1,126 | 343 | 226 | 290 | 0.92 | 1.86 | 253d895f18 |
| mind2web | V2O020 | 1,390 |  | 1,115 | 332 | 226 | 293 | 0.91 | 1.81 | 253d895f18 |
| mind2web | V2Smain | 1,316 | 1,316 | 1,076 | 292 | 247 | 282 | 1.02 | 1.85 | 253d895f18 |
| mind2web | V2Omain | 1,306 |  | 1,067 | 284 | 232 | 282 | 1.06 | 1.82 | 253d895f18 |
| mind2web | E | 959 |  | 839 |  | 325 | 154 | 0.77 | 0.84 | a0ed8de8a0 |
| mind2web | E0 | 861 |  | 783 |  | 226 | 154 | 0.78 | 0.84 | a0ed8de8a0 |
| mind2web | E0main | 862 |  | 783 |  | 226 | 154 | 0.74 | 0.79 | a0ed8de8a0 |
| agentnet | A | 2,930 |  | 2,852 | 2,069 | 983 | 550 | 4.99 | 5.51 | 57fa1dd5fd |
| agentnet | B1 | 1,472 |  | 1,069 | 230 | 330 | 236 | 1.10 | 1.75 | 6946e62ef2 |
| agentnet | V2S020 | 1,028 | 1,028 | 797 | 14 | 227 | 172 | 0.74 | 1.39 | 57fa1dd5fd |
| agentnet | V2O020 | 1,027 |  | 797 | 13 | 227 | 176 | 0.79 | 1.43 | 57fa1dd5fd |
| agentnet | V2Smain | 1,010 | 1,010 | 793 | 10 | 231 | 163 | 0.77 | 1.48 | 57fa1dd5fd |
| agentnet | V2Omain | 1,010 |  | 793 | 10 | 230 | 161 | 0.75 | 1.45 | 57fa1dd5fd |
| agentnet | E | 959 |  | 839 |  | 325 | 154 | 0.70 | 0.79 | 472e9e1ba1 |
| agentnet | E0 | 862 |  | 783 |  | 226 | 155 | 0.75 | 0.82 | 472e9e1ba1 |
| agentnet | E0main | 862 |  | 783 |  | 226 | 154 | 0.71 | 0.79 | 472e9e1ba1 |
| gui_odyssey | A | 1,457 |  | 1,379 | 596 | 368 | 276 | 3.72 | 3.87 | fd455eda6d |
| gui_odyssey | B1 | 1,212 |  | 1,062 | 223 | 329 | 210 | 1.11 | 1.50 | 281d69c354 |
| gui_odyssey | V2S020 | 878 | 878 | 788 | 4 | 228 | 155 | 0.77 | 0.92 | fd455eda6d |
| gui_odyssey | V2O020 | 877 |  | 787 | 4 | 227 | 155 | 0.76 | 0.92 | fd455eda6d |
| gui_odyssey | V2Smain | 876 | 876 | 787 | 4 | 229 | 155 | 0.73 | 0.93 | fd455eda6d |
| gui_odyssey | V2Omain | 876 |  | 787 | 4 | 229 | 155 | 0.75 | 0.93 | fd455eda6d |
| gui_odyssey | E | 959 |  | 839 |  | 325 | 154 | 0.76 | 0.85 | 13fb06c180 |
| gui_odyssey | E0 | 862 |  | 783 |  | 226 | 154 | 0.72 | 0.82 | 13fb06c180 |
| gui_odyssey | E0main | 862 |  | 784 |  | 226 | 154 | 0.72 | 0.81 | 13fb06c180 |

#### fork

| dataset | arm | node peak PSS | incl. tmpfs file | node peak Pss_Anon | anon above floor | parent peak USS | worker peak USS (max) | first batch s | epoch s | batch digest |
|---|---|---|---|---|---|---|---|---|---|---|
| hermes_fc | A | 553 |  | 477 | 286 | 320 | 57 | 0.02 | 0.23 | 15187090b9 |
| hermes_fc | V2S020 | 305 | 305 | 195 | 4 | 227 | 11 | 0.02 | 0.22 | 15187090b9 |
| hermes_fc | V2O020 | 303 |  | 193 | 3 | 227 | 10 | 0.01 | 0.23 | 15187090b9 |
| hermes_fc | V2Smain | 307 | 307 | 197 | 6 | 231 | 11 | 0.02 | 0.20 | 15187090b9 |
| hermes_fc | V2Omain | 303 |  | 193 | 2 | 227 | 10 | 0.02 | 0.22 | 15187090b9 |
| hermes_fc | E | 355 |  | 237 |  | 324 | 6 | 0.02 | 0.16 | b53519f7de |
| hermes_fc | E0 | 267 |  | 191 |  | 226 | 8 | 0.02 | 0.16 | b53519f7de |
| hermes_fc | E0main | 268 |  | 191 |  | 226 | 8 | 0.01 | 0.11 | b53519f7de |
| glaive_fc | A | 796 |  | 720 | 527 | 547 | 60 | 0.04 | 0.32 | e47f0bd3af |
| glaive_fc | B1 | 621 |  | 247 | 8 | 338 | 11 | 0.03 | 0.32 | e47f0bd3af |
| glaive_fc | V2S020 | 397 | 397 | 197 | 4 | 232 | 11 | 0.01 | 0.24 | e47f0bd3af |
| glaive_fc | V2O020 | 395 |  | 195 | 2 | 229 | 11 | 0.01 | 0.21 | e47f0bd3af |
| glaive_fc | V2Smain | 420 | 420 | 220 | 27 | 255 | 11 | 0.02 | 0.19 | e47f0bd3af |
| glaive_fc | V2Omain | 395 |  | 195 | 2 | 230 | 11 | 0.02 | 0.21 | e47f0bd3af |
| glaive_fc | E | 357 |  | 239 |  | 326 | 6 | 0.03 | 0.21 | 3b567fcff5 |
| glaive_fc | E0 | 270 |  | 193 |  | 227 | 9 | 0.01 | 0.17 | 3b567fcff5 |
| glaive_fc | E0main | 270 |  | 193 |  | 227 | 8 | 0.02 | 0.17 | 3b567fcff5 |
| swe_smith | A | 5,091 |  | 5,015 | 4,825 | 2,664 | 2,100 | 0.14 | 5.06 | 6e7444338a |
| swe_smith | B1 | 5,342 |  | 4,512 | 4,276 | 330 | 4,706 | 0.04 | 5.60 | 6e7444338a |
| swe_smith | V2S020 | 4,732 | 4,778 | 4,196 | 4,005 | 226 | 4,276 | 0.04 | 6.11 | 6e7444338a |
| swe_smith | V2O020 | 4,941 |  | 4,406 | 4,215 | 226 | 4,496 | 0.03 | 6.12 | 6e7444338a |
| swe_smith | V2Smain | 5,456 | 5,490 | 4,913 | 4,723 | 264 | 4,887 | 0.03 | 5.94 | 6e7444338a |
| swe_smith | V2Omain | 5,217 |  | 4,673 | 4,482 | 232 | 4,748 | 0.03 | 5.97 | 6e7444338a |
| swe_smith | E | 354 |  | 236 |  | 324 | 6 | 0.02 | 0.11 | 4a3eeb63bf |
| swe_smith | E0 | 267 |  | 190 |  | 226 | 8 | 0.02 | 0.08 | 4a3eeb63bf |
| swe_smith | E0main | 267 |  | 191 |  | 226 | 9 | 0.02 | 0.08 | 4a3eeb63bf |
| swe_rebench | A | 3,431 |  | 3,356 | 3,166 | 1,984 | 363 | 0.14 | 2.22 | 9c3c9136c6 |
| swe_rebench | B1 | 1,537 |  | 286 | 49 | 336 | 226 | 0.04 | 2.44 | 9c3c9136c6 |
| swe_rebench | V2S020 | 943 | 943 | 310 | 120 | 227 | 141 | 0.05 | 2.65 | 9c3c9136c6 |
| swe_rebench | V2O020 | 943 |  | 310 | 120 | 226 | 141 | 0.04 | 2.52 | 9c3c9136c6 |
| swe_rebench | V2Smain | 1,043 | 1,043 | 388 | 197 | 236 | 121 | 0.04 | 2.23 | 9c3c9136c6 |
| swe_rebench | V2Omain | 996 |  | 341 | 151 | 236 | 119 | 0.04 | 2.39 | 9c3c9136c6 |
| swe_rebench | E | 354 |  | 236 |  | 324 | 6 | 0.02 | 0.13 | 1ec8bb40e6 |
| swe_rebench | E0 | 267 |  | 190 |  | 226 | 8 | 0.02 | 0.09 | 1ec8bb40e6 |
| swe_rebench | E0main | 267 |  | 190 |  | 226 | 8 | 0.02 | 0.11 | 1ec8bb40e6 |
| swe_rebench_pq | A | 5,835 |  | 5,711 | 5,521 | 4,380 | 364 | 0.16 | 2.47 | a23b89812b |
| swe_rebench_pq | B1 | 1,479 |  | 293 | 57 | 335 | 168 | 0.04 | 2.01 | a23b89812b |
| swe_rebench_pq | V2S020 | 3,456 | 3,456 | 2,760 | 2,570 | 2,196 | 279 | 0.08 | 2.99 | a23b89812b |
| swe_rebench_pq | V2O020 | 969 |  | 305 | 115 | 226 | 151 | 0.04 | 2.50 | a23b89812b |
| swe_rebench_pq | V2Smain | 3,611 | 3,611 | 2,923 | 2,733 | 2,276 | 255 | 0.06 | 2.70 | a23b89812b |
| swe_rebench_pq | V2Omain | 996 |  | 341 | 150 | 236 | 118 | 0.04 | 2.24 | a23b89812b |
| swe_rebench_pq | E | 354 |  | 236 |  | 324 | 6 | 0.02 | 0.12 | 1ec8bb40e6 |
| swe_rebench_pq | E0 | 267 |  | 190 |  | 226 | 8 | 0.01 | 0.08 | 1ec8bb40e6 |
| swe_rebench_pq | E0main | 267 |  | 190 |  | 226 | 8 | 0.02 | 0.09 | 1ec8bb40e6 |
| mind2web | A | 1,669 |  | 1,593 | 1,403 | 1,081 | 150 | 0.18 | 0.83 | 253d895f18 |
| mind2web | B1 | 1,096 |  | 483 | 246 | 331 | 196 | 0.16 | 0.80 | 253d895f18 |
| mind2web | V2S020 | 775 | 838 | 563 | 373 | 226 | 165 | 0.20 | 1.05 | 253d895f18 |
| mind2web | V2O020 | 789 |  | 514 | 324 | 226 | 144 | 0.20 | 1.07 | 253d895f18 |
| mind2web | V2Smain | 721 | 721 | 482 | 292 | 246 | 119 | 0.20 | 1.02 | 253d895f18 |
| mind2web | V2Omain | 670 |  | 431 | 241 | 231 | 110 | 0.21 | 1.05 | 253d895f18 |
| mind2web | E | 354 |  | 236 |  | 324 | 6 | 0.02 | 0.09 | a0ed8de8a0 |
| mind2web | E0 | 266 |  | 190 |  | 225 | 8 | 0.02 | 0.07 | a0ed8de8a0 |
| mind2web | E0main | 266 |  | 190 |  | 225 | 8 | 0.01 | 0.08 | a0ed8de8a0 |
| agentnet | A | 1,218 |  | 1,143 | 952 | 619 | 149 | 0.05 | 0.59 | 57fa1dd5fd |
| agentnet | B1 | 657 |  | 256 | 20 | 329 | 38 | 0.03 | 0.66 | 6946e62ef2 |
| agentnet | V2S020 | 435 | 435 | 206 | 15 | 227 | 19 | 0.02 | 0.62 | 57fa1dd5fd |
| agentnet | V2O020 | 434 |  | 205 | 14 | 226 | 18 | 0.02 | 0.64 | 57fa1dd5fd |
| agentnet | V2Smain | 419 | 419 | 204 | 14 | 230 | 14 | 0.02 | 0.71 | 57fa1dd5fd |
| agentnet | V2Omain | 416 |  | 201 | 11 | 230 | 14 | 0.02 | 0.72 | 57fa1dd5fd |
| agentnet | E | 354 |  | 236 |  | 324 | 6 | 0.02 | 0.12 | 472e9e1ba1 |
| agentnet | E0 | 267 |  | 191 |  | 226 | 9 | 0.02 | 0.10 | 472e9e1ba1 |
| agentnet | E0main | 267 |  | 190 |  | 226 | 8 | 0.01 | 0.08 | 472e9e1ba1 |
| gui_odyssey | A | 557 |  | 482 | 291 | 337 | 54 | 0.02 | 0.19 | fd455eda6d |
| gui_odyssey | B1 | 395 |  | 248 | 12 | 328 | 10 | 0.03 | 0.45 | 281d69c354 |
| gui_odyssey | V2S020 | 291 | 291 | 203 | 13 | 227 | 12 | 0.01 | 0.17 | fd455eda6d |
| gui_odyssey | V2O020 | 284 |  | 195 | 5 | 227 | 10 | 0.02 | 0.18 | fd455eda6d |
| gui_odyssey | V2Smain | 281 | 281 | 194 | 3 | 229 | 10 | 0.02 | 0.21 | fd455eda6d |
| gui_odyssey | V2Omain | 281 |  | 193 | 3 | 228 | 10 | 0.02 | 0.19 | fd455eda6d |
| gui_odyssey | E | 354 |  | 236 |  | 324 | 6 | 0.02 | 0.14 | 13fb06c180 |
| gui_odyssey | E0 | 267 |  | 190 |  | 226 | 8 | 0.02 | 0.10 | 13fb06c180 |
| gui_odyssey | E0main | 267 |  | 191 |  | 226 | 8 | 0.02 | 0.10 | 13fb06c180 |

### Queries on packed data (main) against a loop over the list

| dataset | query | equal | list ms | packmem ms | answer (head) |
|---|---|---|---|---|---|
| hermes_fc | turns_per_record | True | 1.0 | 0.1 | `[3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,` |
| hermes_fc | chars_per_record | True | 10.1 | 27.3 | `[5002, 2578, 2999, 3416, 2189, 3779, 3106, 3089, 3671, 2841,` |
| hermes_fc | has_tools_key | True | 0.6 | 0.1 | `[True, True, True, True, True, True, True, True, True, True,` |
| hermes_fc | by_category | True | 1.4 | 0.1 | `{'IoT and Home Automation': 30, 'Quantum Computing': 16, 'Se` |
| glaive_fc | chars_of_chat | True | 22.3 | 174.1 | `[274, 1350, 561, 641, 493, 909, 438, 273, 447, 505, 1080, 47` |
| glaive_fc | chats_with_functioncall | True | 64.7 | 236.8 | `63218` |
| swe_smith | turns_per_record | True | 0.5 | 0.0 | `[49, 43, 65, 49, 49, 37, 45, 35, 51, 29, 51, 25, 77, 25, 35,` |
| swe_smith | records_with_tool_call_submit | True | 57.6 | 2,030.3 | `[True, True, True, True, True, True, True, True, True, False` |
| swe_smith | role_counts | True | 29.1 | 1,930.0 | `{'system': 3013, 'user': 33150, 'assistant': 89926, 'tool': ` |
| swe_smith | tool_turns_per_record | True | 40.4 | 1,893.8 | `[23, 20, 31, 23, 23, 17, 21, 16, 24, 13, 24, 11, 37, 11, 16,` |
| swe_smith | resolved | True | 0.2 | 0.0 | `1412` |
| swe_rebench | turns_per_record | True | 1.9 | 0.0 | `[185, 91, 137, 157, 131, 169, 119, 103, 169, 97, 105, 85, 10` |
| swe_rebench | records_with_tool_call_task_tracker | True | 147.1 | 5,033.1 | `[False, False, False, False, False, False, False, False, Tru` |
| swe_rebench | role_counts | True | 62.8 | 4,797.2 | `{'system': 4000, 'user': 4014, 'assistant': 256853, 'tool': ` |
| swe_rebench | tool_turns_per_record | True | 88.3 | 4,621.3 | `[91, 44, 67, 77, 64, 83, 58, 50, 83, 47, 51, 41, 52, 58, 54,` |
| swe_rebench | by_exit_status | True | 0.4 | 0.0 | `{'submit': 3619, 'RuntimeError: Agent reached maximum iterat` |
| swe_rebench_pq | turns_per_record | True | 0.7 | 0.0 | `[185, 91, 137, 157, 131, 169, 119, 103, 169, 97, 105, 85, 10` |
| swe_rebench_pq | records_with_tool_call_task_tracker | True | 144.2 | 5,362.1 | `[False, False, False, False, False, False, False, False, Tru` |
| swe_rebench_pq | role_counts | True | 66.6 | 5,127.0 | `{'system': 4000, 'user': 4014, 'assistant': 256853, 'tool': ` |
| swe_rebench_pq | tool_turns_per_record | True | 75.2 | 4,946.7 | `[91, 44, 67, 77, 64, 83, 58, 50, 83, 47, 51, 41, 52, 58, 54,` |
| swe_rebench_pq | by_exit_status | True | 0.2 | 0.0 | `{'submit': 3619, 'RuntimeError: Agent reached maximum iterat` |
| mind2web | turns_per_record | True | 0.0 | 0.0 | `[11, 19, 7, 11, 10, 12, 20, 11, 5, 7, 12, 14, 7, 17, 5, 2, 1` |
| mind2web | click_steps_per_record | True | 0.8 | 2,074.3 | `[7, 15, 2, 9, 10, 10, 16, 11, 4, 7, 11, 12, 7, 6, 4, 1, 9, 1` |
| mind2web | cleaned_html_chars_per_record | True | 0.2 | 114.6 | `[627013, 1239581, 1184050, 2641652, 2491741, 1307965, 489380` |
| mind2web | by_domain | True | 0.0 | 0.0 | `{'Travel': 80, 'Shopping': 63, 'Entertainment': 57}` |
| agentnet | turns_per_record | True | 1.5 | 0.0 | `[7, 8, 11, 14, 9, 15, 15, 19, 10, 10, 15, 18, 34, 12, 17, 21` |
| agentnet | click_steps_per_record | True | 9.3 | 1,073.4 | `[3, 6, 6, 11, 6, 9, 8, 14, 7, 1, 7, 2, 27, 7, 13, 19, 9, 3, ` |
| agentnet | completed | True | 0.8 | 0.0 | `2316` |
| agentnet | by_domain | True | 1.0 | 0.0 | `{'infeasible': 200, 'VScode': 605, 'libreoffice_impress': 60` |
| gui_odyssey | turns_per_record | True | 3.3 | 0.1 | `[11, 17, 25, 8, 7, 22, 16, 18, 15, 11, 33, 20, 22, 17, 18, 2` |
| gui_odyssey | click_steps_per_record | True | 29.1 | 922.0 | `[9, 13, 13, 6, 5, 14, 11, 11, 10, 8, 27, 15, 15, 9, 14, 17, ` |
| gui_odyssey | by_device | True | 3.1 | 0.0 | `{'Pixel 8 Pro': 1288, 'Pixel 7 Pro': 1312, 'Medium Phone': 1` |
| gui_odyssey | pixel8_episodes | True | 0.8 | 0.0 | `1288` |

### Threaded load (main): PACKMEM_THREADS=1 against the default (MB; median of fresh processes)

| file | setting | runs | load s | Pss_Anon after load | RSS after load | Pss_Anon after 5 s | RSS after 5 s | VmHWM | ru_maxrss | nbytes | identical to_bytes() |
|---|---|---|---|---|---|---|---|---|---|---|---|
| agentnet | t1 | 5 | 2.523 | 177.4 | 189.8 | 177.4 | 189.8 | 992.1 | 992.1 | 138.0 | True |
| agentnet | tdefault | 5 | 2.982 | 179.4 | 192.0 | 179.4 | 192.0 | 993.4 | 993.4 | 138.0 | True |
| flights | t1 | 5 | 0.354 | 24.8 | 37.2 | 24.8 | 37.2 | 37.3 | 37.2 | 8.1 | True |
| flights | tdefault | 5 | 0.123 | 43.1 | 55.7 | 43.1 | 55.7 | 161.7 | 161.7 | 8.1 | True |
| llava_v1_5_mix665k | t1 | 5 | 9.971 | 356.8 | 369.2 | 356.8 | 369.2 | 532.9 | 532.9 | 296.2 | True |
| llava_v1_5_mix665k | tdefault | 5 | 2.425 | 503.8 | 516.3 | 503.8 | 516.3 | 2,030.1 | 2,030.1 | 296.2 | True |
| swe_rebench | t1 | 5 | 8.682 | 805.3 | 817.7 | 805.3 | 817.7 | 3,119.0 | 3,119.0 | 578.3 | True |
| swe_rebench | tdefault | 5 | 9.601 | 810.1 | 822.6 | 810.1 | 822.6 | 3,393.3 | 3,393.3 | 578.3 | True |

agentnet: peak RSS default / threads=1 = 1.00; load time threads=1 / default = 0.85

flights: peak RSS default / threads=1 = 4.34; load time threads=1 / default = 2.88

llava_v1_5_mix665k: peak RSS default / threads=1 = 3.81; load time threads=1 / default = 4.11

swe_rebench: peak RSS default / threads=1 = 1.09; load time threads=1 / default = 0.90

Runs: 464; 1-minute load at run start/end 3.1-58.2; failed: dl.hermes_fc.B1.fork.1, dl.hermes_fc.B1.forkserver.1

## Suite 1b: GC pauses with in-flight episodes

Episodes of 100 nodes (+-20%), batches of 256, steady-state turnover 1.0 x N, 400 small objects per tick.

| python | arm | N | tracked objects | gc.collect() s (median) | fill gen-2 count / max s | steady gen-2 count | steady gen-2 median s | steady gen-2 max s | steady gen-2 total s | tick p99 ms | tick max s | tick max s without a batch hand-off | Pss_Anon filled MB | VmHWM MB | pack batch s | read episode us |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| py314 3.14.10 | dict | 1000 | 534,231 | 0.282 | 1 / 0.083 | 1 | 0.338 | 0.338 | 0.34 | 6.7 | 0.339 | 0.339 | 687 | 929 |  | 47 |
| py314 3.14.10 | dict | 4000 | 2,593,428 | 0.566 | 7 / 0.474 | 3 | 0.605 | 0.620 | 1.82 | 2.9 | 0.622 | 0.622 | 3,266 | 3,514 |  | 28 |
| py314 3.14.10 | dict | 16000 | 10,643,119 | 2.297 | 14 / 2.283 | 4 | 2.460 | 2.551 | 9.82 | 3.9 | 2.553 | 2.553 | 13,309 | 13,557 |  | 29 |
| py314 3.14.10 | pmmain | 1000 | 27,095 | 0.002 | 3 / 0.123 | 3 | 0.117 | 0.128 | 0.33 | 11.6 | 1.216 | 0.016 | 686 | 931 | 1.105 | 3,355 |
| py314 3.14.10 | pmmain | 4000 | 27,143 | 0.002 | 16 / 0.052 | 16 | 0.050 | 0.072 | 0.69 | 3.9 | 0.790 | 0.059 | 2,148 | 2,471 | 0.680 | 1,764 |
| py314 3.14.10 | pmmain | 16000 | 27,331 | 0.002 | 69 / 0.071 | 69 | 0.059 | 0.115 | 3.97 | 4.8 | 0.893 | 0.074 | 7,792 | 8,325 | 0.703 | 1,829 |
| sys 3.12.3 | dict | 1000 | 318,469 | 0.164 | 5 / 0.249 | 3 | 0.157 | 0.193 | 0.50 | 5.9 | 0.196 | 0.196 | 686 | 926 |  | 31 |
| sys 3.12.3 | dict | 4000 | 1,522,866 | 0.474 | 12 / 0.467 | 3 | 0.536 | 0.571 | 1.63 | 1.8 | 0.573 | 0.573 | 3,266 | 3,512 |  | 26 |
| sys 3.12.3 | dict | 16000 | 6,231,089 | 1.987 | 18 / 1.797 | 4 | 2.237 | 2.371 | 8.93 | 1.9 | 2.373 | 2.373 | 13,310 | 13,557 |  | 27 |
| sys 3.12.3 | pm020 | 1000 | 24,219 | 0.002 | 9 / 0.144 | 9 | 0.070 | 0.183 | 0.81 | 20.0 | 1.329 | 0.109 | 682 | 868 | 1.081 | 1,235 |
| sys 3.12.3 | pm020 | 4000 | 24,243 | 0.002 | 47 / 0.055 | 47 | 0.046 | 0.089 | 2.16 | 8.4 | 0.873 | 0.062 | 2,232 | 2,418 | 0.704 | 921 |
| sys 3.12.3 | pm020 | 16000 | 24,337 | 0.002 | 194 / 0.080 | 187 | 0.051 | 0.118 | 10.21 | 3.4 | 0.939 | 0.068 | 8,216 | 8,423 | 0.734 | 929 |
| sys 3.12.3 | pmmain | 1000 | 24,305 | 0.002 | 9 / 0.089 | 9 | 0.101 | 0.139 | 0.81 | 41.5 | 1.396 | 0.105 | 688 | 934 | 1.031 | 2,673 |
| sys 3.12.3 | pmmain | 4000 | 24,329 | 0.002 | 47 / 0.077 | 47 | 0.041 | 0.081 | 1.92 | 9.5 | 0.857 | 0.045 | 2,145 | 2,450 | 0.743 | 2,020 |
| sys 3.12.3 | pmmain | 16000 | 24,423 | 0.002 | 194 / 0.074 | 187 | 0.054 | 0.100 | 9.78 | 4.3 | 0.946 | 0.055 | 7,786 | 8,347 | 0.777 | 2,083 |
