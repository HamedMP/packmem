# Agent history archive

`packmem archive` keeps your Claude Code and Codex transcripts, compressed, after the agents delete them. Claude
Code removes transcripts after 30 days by default. The archive keeps a private copy on your machine that you can
restore byte for byte, and answers history-wide questions without decompressing any session.

```sh
npx packmem archive --dry-run   # what would be archived and the expected size; writes nothing
npx packmem archive             # archive every session unchanged for a day
```

It needs Node 20 or newer. On Node 22.15 and newer it compresses with zstd; on older Node it uses Brotli, which
is slower and gives a somewhat larger archive.

## What it reads and writes

- **Reads** `~/.claude/projects` (or each `CLAUDE_CONFIG_DIR` entry's `projects`, or `$XDG_CONFIG_HOME/claude/projects`),
  including subagent transcripts, and `~/.codex/sessions` and `~/.codex/archived_sessions` (or `$CODEX_HOME`).
  Codex's own `.jsonl.zst` files are already compressed; they are counted and left as they are.
- **Writes** only to `~/.packmem/agent-history` (or `--dir`, or `PACKMEM_ARCHIVE_DIR`). Files there are readable
  only by you (`0600`, directories `0700`).
- **Never** deletes, moves or changes an agent's own files. Space is freed when the agent's own cleanup removes the
  originals; until then the archive is extra.
- **Stays local.** Nothing is sent anywhere.

## Safety rules

- A session counts as archived only after it has been read back from the archive and matched the sha256 of the
  original. A session that does not match is reported and not recorded.
- Every later read checks the sha256 again, so a damaged archive is reported, not served.
- Sessions changed in the last day are left for a later run (`--older-than` changes the window), and a session that
  changes while it is being read is skipped. A session that grows later is archived again.
- It writes only into a folder that is new, empty, or already an archive, and `delete --all` removes only the files
  the archive wrote there, so pointing `--dir` at the wrong folder cannot clear it.
- `restore` never overwrites a file, even one created while it runs.
- One run writes at a time (a lock file); an interrupted run leaves nothing that looks valid.
- When a session changed and is archived again, text only its earlier version used is removed in the same run.
- The archive is a full copy of your transcripts, including anything sensitive in them, such as a token a command
  printed. It is kept after the agents delete their copies. Delete it when you no longer want it.

## Commands

```sh
npx packmem archive status                         # sessions, original size, archive size
npx packmem archive list                           # archived sessions, newest first
npx packmem archive verify                         # re-check every session against its original's sha256
npx packmem archive restore claude-code/<id>       # write it back where it was, if nothing is there now
npx packmem archive restore codex/<id> --to x.jsonl
npx packmem archive stats --by tool                # counts across all history, read in place
npx packmem archive delete claude-code/<id>        # delete one archived copy and the text only it used
npx packmem archive delete --all --yes             # delete the whole archive
```

`restore` never overwrites a file. `delete` never touches the agent's own files. Add `--json` to any command for
machine-readable output; it carries sizes, ids and counts, never transcript text.

## How it saves space

Agent transcripts repeat themselves. Claude Code stores each tool result twice, Codex logs each item twice, and the
same file contents, instructions and skill lists come back session after session. The archive stores every string
of 256 bytes or more once, across all sessions, in compressed frames grouped by the JSON key it came from, and keeps
each session as a small compressed skeleton that points at those strings. A line that is not JSON, or that would not
re-serialise to the same bytes, is kept as written.

Next to it, a packmem table of one row per record (type, time, tool, model, token counts, size; no text) lets
`stats` answer questions about all of your history without decompressing a session.

## Measurements

Two measurements. Raw results are in
[node/bench/results](https://github.com/HamedMP/packmem/tree/main/node/bench/results) (`agent-history-*.json`).

**Synthetic history, reproducible.** 600 sessions (358.3 MB of JSONL) from `node bench/agent-history-data.mjs data 10`,
which imitates the repetition measured in real transcripts. Linux, AMD Ryzen 9 7950X3D, Node 24.22, on a shared
server whose load average ran from 30 to 9 during the runs, so the times are indicative.

| | size on disk | compared with JSONL |
| --- | --- | --- |
| JSONL as the agents write it | 358.3 MB | 1x |
| zstd -19, each file on its own | 69.4 MB | 5.2x smaller |
| `packmem archive` | 38.0 MB | 9.4x smaller |
| zstd -19, all files as one stream with a 128 MB window | 28.2 MB | 12.7x smaller |

The single stream is the smallest, but it cannot take a new session without recompressing everything, and reading
one session means decompressing up to it. The archive takes new sessions in later runs and restores any one on its
own. Archiving took 103 s and peaked at 444 MB of memory (measured alone); verifying all 600 sessions took 50 s.

**One person's own history.** About 450 Claude Code and Codex sessions, about 1 GB of JSONL, on an Apple M4 Pro
with macOS and Node 24.18. It ran on that machine because the transcripts are private and were not copied anywhere,
so others cannot reproduce it; the file holds rounded sizes only.

| | size on disk | compared with JSONL |
| --- | --- | --- |
| JSONL | about 1.0 GB | 1x |
| zstd -19, each file on its own | about 240 MB | 4.0x smaller |
| `packmem archive` | about 210 MB | 4.7x smaller |

Archiving took 112 s with a peak of about 1.2 GB of memory, which on macOS includes memory the allocator freed but
kept; verifying every session took 45 s. Sessions Codex had already compressed were left as they are. How much
smaller your archive comes out depends on how much your sessions repeat each other: this history is mostly Codex,
whose sessions share less than the synthetic ones do.

A later run with the current code, on the same machine and a later state of the same history (about 430 sessions,
about 0.9 GB: some sessions had become too recent, others had been removed by the agents' own cleanup), archived it
into about 190 MB (4.9x smaller) in 133 s, with a peak of about 0.96 GB. The zstd baseline was not re-run on that set.

## Limits

- Only Claude Code and Codex for now.
- Sessions in Codex's own `.jsonl.zst` files are not archived.
- Archiving is not light on memory: 444 MB for 358 MB of synthetic history on Linux, and about 1 GB for about 0.9 GB
  of real history on macOS, where the allocator keeps memory it has freed.
- Reading a full session needs a restore. A later format will store sessions as packmem tables that can be read in
  place.
