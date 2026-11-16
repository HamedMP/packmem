import { readFileSync } from "node:fs";
import { AGENTS } from "./sources.js";
import * as api from "./archive.js";

const HELP = `packmem archive: keep your AI coding-agent history, compressed, after the agent deletes it.

Finds Claude Code and Codex transcripts in their default places, stores each long piece of text once across
all sessions, and checks that every session restores byte for byte before counting it as archived.
It never deletes or changes the agents' own files. Everything stays on this machine.

Usage
  packmem archive [options]              archive sessions that have not changed for a day
  packmem archive --dry-run              show what would be archived and the expected size; write nothing
  packmem archive status                 what is archived and how much space it takes
  packmem archive list                   archived sessions, newest first
  packmem archive verify [<agent>/<id>]  re-check archived sessions against the originals' sha256
  packmem archive restore <agent>/<id> [--to <path>]
                                         write a session back, byte for byte; never overwrites
  packmem archive stats [--by <field>]   counts across all archived history, without decompressing it
  packmem archive delete <agent>/<id>    delete one archived copy (never the agent's own file)
  packmem archive delete --all --yes     delete the whole archive (never the agents' own files)

Options
  --older-than <days>  only sessions unchanged for this long (default 1; 0 includes active ones)
  --agent <name>       only one of: ${AGENTS.join(", ")}
  --max <n>            archive at most n sessions this run, newest first
  --by <field>         stats: type, tool, model, day, agent or session (default tool)
  --dir <path>         archive location (default ~/.packmem/agent-history, or PACKMEM_ARCHIVE_DIR)
  --json               print JSON instead of text
  -h, --help           show this help

Reads ~/.claude/projects (or CLAUDE_CONFIG_DIR) and ~/.codex/sessions and archived_sessions (or CODEX_HOME).
The archive is a full private copy of those transcripts, including anything sensitive in them; its files are
readable only by you. Docs: https://hamedmp.github.io/packmem/docs/agent-history/
`;

class UsageError extends Error {}

const VALUE = new Set(["--older-than", "--agent", "--max", "--by", "--dir", "--to"]);
const FLAGS = new Set(["--dry-run", "--json", "--all", "--yes", "-h", "--help"]);
const SUBCOMMANDS = new Set(["status", "list", "verify", "restore", "stats", "delete"]);
const BY = new Set(["type", "tool", "model", "day", "agent", "session"]);

export function parse(argv) {
  const o = { sub: "run", positional: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("-")) {
      if (o.sub === "run" && o.positional.length === 0 && SUBCOMMANDS.has(raw)) o.sub = raw;
      else o.positional.push(raw);
      continue;
    }
    const eq = raw.indexOf("=");
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    if (VALUE.has(flag)) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      o[flag.slice(2)] = value;
    } else if (FLAGS.has(flag) && eq < 0) o.flags.add(flag);
    else throw new UsageError(`unknown option "${raw}"`);
  }
  if (o.agent !== undefined && !AGENTS.includes(o.agent)) throw new UsageError(`--agent must be one of: ${AGENTS.join(", ")}`);
  if (o.by !== undefined && !BY.has(o.by)) throw new UsageError(`--by must be one of: ${[...BY].join(", ")}`);
  for (const key of ["older-than", "max"]) {
    if (o[key] === undefined) continue;
    const n = Number(o[key]);
    if (!Number.isFinite(n) || n < 0 || (key === "max" && (!Number.isInteger(n) || n < 1))) throw new UsageError(`--${key} must be ${key === "max" ? "a whole number, 1 or more" : "a number of days, 0 or more"}`);
    o[key] = n;
  }
  const needsTarget = o.sub === "restore" || (o.sub === "delete" && !o.flags.has("--all")) || (o.sub === "verify" && o.positional.length > 0);
  if (needsTarget) o.target = target(o.positional[0]);
  const allowed = needsTarget ? 1 : 0;
  if (o.positional.length > allowed) throw new UsageError(`unexpected argument "${o.positional[allowed]}"`);
  return o;
}

function target(value) {
  const [agent, id, ...rest] = (value ?? "").split("/");
  if (!agent || !id || rest.length || !AGENTS.includes(agent)) throw new UsageError("expected <agent>/<id>, for example claude-code/0b5c1f2e-…; `packmem archive list` shows them");
  return { agent, id };
}

const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

export async function run(argv, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), env: process.env, now: () => new Date() }) {
  let o;
  try {
    o = parse(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`packmem archive: ${error.message}\nRun \`packmem archive --help\` for usage.\n`);
    return 2;
  }
  if (o.flags.has("-h") || o.flags.has("--help")) {
    io.out(HELP);
    return 0;
  }
  const config = { dir: o.dir ?? api.defaultDir(io.env), ...(io.roots ? { roots: io.roots } : {}) };
  const json = o.flags.has("--json");
  const print = (value, text) => io.out(json ? `${JSON.stringify(value, null, 1)}\n` : text);
  try {
    switch (o.sub) {
      case "status": {
        const s = await api.status(config);
        print(s, s.sessions === 0
          ? `Nothing archived yet in ${s.dir}. Run \`packmem archive --dry-run\` to see what would be.\n`
          : `${s.sessions} sessions archived in ${s.dir}\n` +
            `${mb(s.sourceBytes)} of transcripts kept in ${mb(s.archiveBytes)} (${s.ratio}x smaller), ${s.codec}\n` +
            Object.entries(s.byAgent).map(([a, v]) => `  ${a}: ${v.sessions} sessions, ${mb(v.sourceBytes)}\n`).join("") +
            `From ${s.oldest.slice(0, 10)} to ${s.newest.slice(0, 10)}.\n`);
        return 0;
      }
      case "list": {
        const page = await api.list(config, { ...(o.agent ? { agent: o.agent } : {}), limit: 100_000 });
        print(page, page.sessions.map((s) => `${s.agent}/${s.id}  ${s.modified.slice(0, 10)}  ${mb(s.sourceBytes)}\n`).join("") + `${page.total} archived sessions\n`);
        return 0;
      }
      case "verify": {
        const r = await api.verify(config, o.target ?? "all");
        print(r, r.bad.length
          ? `${r.bad.length} of ${r.sessions} sessions do not match their originals:\n` + r.bad.map((b) => `  ${b.agent}/${b.id}: ${b.reason}\n`).join("")
          : `All ${r.sessions} archived sessions restore byte for byte (${mb(r.bytes)} checked).\n`);
        return r.bad.length ? 1 : 0;
      }
      case "restore": {
        const r = await api.restore(config, o.target.agent, o.target.id, o.to ? { to: o.to } : {});
        print(r, `Restored ${o.target.agent}/${o.target.id} (${mb(r.bytes)}, identical to the original) to ${r.path}\n`);
        return 0;
      }
      case "stats": {
        const by = o.by ?? "tool";
        const r = await api.query(config, { groupBy: by, sum: "outTok", ...(o.agent ? { agent: o.agent } : {}) });
        print(r, `${r.rows} records across archived history; ${r.sum} output tokens recorded\nTop by ${by}:\n` +
          r.groups.filter((g) => g.key !== "").slice(0, 15).map((g) => `  ${String(g.count).padStart(8)}  ${g.key}\n`).join(""));
        return 0;
      }
      case "delete": {
        if (o.flags.has("--all")) {
          if (!o.flags.has("--yes")) {
            io.err("packmem archive: `delete --all` removes every archived session (the agents' own files stay). Add --yes to confirm.\n");
            return 2;
          }
          const r = await api.remove(config, "all");
          print(r, `Deleted the archive (${r.removed} sessions). The agents' own transcripts were not touched.\n`);
          return 0;
        }
        const r = await api.remove(config, o.target);
        print(r, `Deleted the archived copy of ${o.target.agent}/${o.target.id}, and any text no other session uses. The agent's own file was not touched.\n`);
        return 0;
      }
      default: {
        const r = await api.archive(config, {
          dryRun: o.flags.has("--dry-run"),
          now: io.now(),
          ...(o["older-than"] !== undefined ? { olderThanDays: o["older-than"] } : {}),
          ...(o.agent ? { agent: o.agent } : {}),
          ...(o.max ? { maxSessions: o.max } : {}),
        });
        const planned = r.planned.reduce((n, p) => n + p.sizeBytes, 0);
        const recent = r.skipped.filter((x) => x.reason === "too_recent").length;
        const found = Object.entries(r.roots).map(([a, roots]) => `  ${a}: ${roots.length ? roots.join(", ") : "no history found"}\n`).join("");
        const pre = r.precompressed ? `${r.precompressed} Codex sessions are already compressed by Codex (${mb(r.precompressedBytes)}) and are left as they are.\n` : "";
        const later = recent ? `${recent} sessions changed in the last ${o["older-than"] ?? 1} day(s) and are left for a later run.\n` : "";
        if (r.dryRun) {
          print(r, `Looked in:\n${found}Would archive ${r.planned.length} sessions (${mb(planned)}).\n` +
            (r.planned.length ? `Expected archive size: about ${mb(r.estimatedBytes)}, from zstd on a ${mb(r.sampledBytes)} sample; storing repeated text once usually makes it smaller.\n` : "") +
            later + pre + "Nothing was written.\n");
          return 0;
        }
        print(r, `Archived ${r.archived} sessions: ${mb(r.sourceBytes)} of transcripts took ${mb(r.addedBytes)} in ${config.dir}\n` +
          later + pre +
          r.failed.map((f) => `Not archived, did not restore identically: ${f.agent}/${f.id}\n`).join("") +
          "The agents' own files were not changed. The archive is a private copy that stays after the agents delete theirs.\n");
        return r.failed.length ? 1 : 0;
      }
    }
  } catch (error) {
    if (error instanceof api.ArchiveBusy || error instanceof api.ArchiveNotFound || error instanceof api.ArchiveTargetExists || error instanceof api.ArchiveCorrupt || error instanceof api.ArchiveForeignDir) {
      io.err(`packmem archive: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

export function version() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}
