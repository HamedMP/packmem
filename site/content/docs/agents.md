# For coding agents

Give your coding agent (Claude Code, Cursor, Codex, Copilot and others) what it needs to use packmem correctly:
the docs as Markdown, and a skill file with the API and the rules.

## The docs as Markdown

- [/llms.txt](/llms.txt): an index of these pages, in the [llms.txt](https://llmstxt.org) format.
- [/llms-full.txt](/llms-full.txt): every page as one Markdown file. Paste the URL into your agent's chat, or add it
  as a docs source.

Both are generated from the same files as these pages, so they always match the site.

## The skill file

Copy the file below into your project. Claude Code reads it from `.claude/skills/packmem/SKILL.md`; for other
agents, add it to `AGENTS.md` or the agent's rules file, or keep it in the repository and point the agent at it. The
same file is in the repository at
[skills/packmem/SKILL.md](https://github.com/HamedMP/packmem/blob/main/skills/packmem/SKILL.md).

```sh
mkdir -p .claude/skills/packmem
curl -o .claude/skills/packmem/SKILL.md https://raw.githubusercontent.com/HamedMP/packmem/main/skills/packmem/SKILL.md
```

{{SKILL}}

## A prompt to start with

```text
Replace the list of dicts loaded in <file> with a packmem table (https://hamedmp.github.io/packmem/llms-full.txt).
Keep the behaviour the same: the endpoints must return identical JSON. Use the loader that matches how the data
is read today, use the table's queries instead of Python or JavaScript loops where it filters or counts, and
measure the process's memory before and after.
```

## Working on packmem itself

The repository has an [AGENTS.md](https://github.com/HamedMP/packmem/blob/main/AGENTS.md) with its layout, build
and test commands, and the rules for changing the byte format and publishing numbers.
