# linux-x86-fast-ci-dev

- AMD Ryzen 9 7950X3D, 16 cores / 32 threads, 124 GB
- Ubuntu 24.04.5, kernel 6.8.0-139-generic, glibc 2.39
- cpufreq driver amd-pstate-epp, governor "powersave" (the dynamic EPP mode)
- Python 3.12.3, pandas 3.1.1, polars 2.1.0, pyarrow 26.0.1; packmem wheel built on the machine
- Load average 0.6 to 1.3 during the runs. The machine also hosts four CI runner containers,
  which were idle throughout.

Memory here is resident set size, not the physical-footprint measure used on macOS.
Query answers in `datasets.jsonl` are identical to the Mac run's.

## Tuned-polars files

`polars_tuned*.jsonl` were recorded twice (`*_run1` is the first attempt), and CI jobs started on
the machine during both: load average reached 25 to 39 (see `polars_run_log.txt`). **Use the memory
figures only.** Across the two runs the list and packmem are identical and the tuned polars variants
with the allocator returning memory agree within 2.5%; polars without that setting varies by up
to 23%. The timings in these four files are not valid and are not quoted anywhere.
