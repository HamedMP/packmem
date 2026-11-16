# Agent history archive results

- `agent-history-archive.json`: `node bench/agent-history.mjs data work results/agent-history-archive.json archive` on the
  synthetic set from `node bench/agent-history-data.mjs data 10`. Archive size and time, verify time, and the two zstd
  baselines. Its `max_rss_bytes` covers the whole process, including the one-stream baseline that holds all 358 MB in
  one buffer, so it is not the archive's peak.
- `agent-history-archive-peak.json`: the archive alone, timed with `/usr/bin/time -v`, for its peak memory.
- `agent-history-use.json`: one question across all sessions (records by type) from packmem tables against zstd
  files that are decompressed and parsed. For the planned table-based archive format.
- `agent-history-own-history.json`: the archive on one person's own transcripts, on a Mac. Rounded sizes only.
