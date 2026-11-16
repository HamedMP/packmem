import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where each agent keeps its transcripts by default, honouring the agents' own environment overrides. */

export const AGENTS = ["claude-code", "codex"];
const MAX_FILES = 200_000;
const MAX_DEPTH = 8;

export function defaultRoots(agent, env = process.env, home = homedir()) {
  if (agent === "claude-code") {
    const configured = (env.CLAUDE_CONFIG_DIR ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    if (configured.length) return configured.map((dir) => join(resolve(dir), "projects"));
    const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
    return [join(home, ".claude", "projects"), join(xdg, "claude", "projects")];
  }
  if (agent === "codex") {
    const codexHome = env.CODEX_HOME?.trim() ? resolve(env.CODEX_HOME.trim()) : join(home, ".codex");
    return [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  }
  return [];
}

/**
 * Every transcript under the roots, including Claude Code subagent transcripts. Codex's own `.jsonl.zst` files are
 * counted but not archived: Codex has already compressed them, and the archive restores plain JSONL.
 */
export async function discover(agent, roots = defaultRoots(agent)) {
  const files = [];
  let precompressed = 0;
  let precompressedBytes = 0;
  const seen = new Set();
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !seen.has(path)) {
        const info = await stat(path).catch(() => null);
        if (!info) continue;
        seen.add(path);
        files.push({ agent, path, mtimeMs: info.mtimeMs, sizeBytes: info.size });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl.zst")) {
        precompressed++;
        precompressedBytes += (await stat(path).catch(() => ({ size: 0 }))).size;
      }
    }
  }
  const found = [];
  for (const root of roots) {
    const info = await stat(root).catch(() => null);
    if (info?.isDirectory()) {
      found.push(root);
      await walk(root, 0);
    }
  }
  return { files, roots: found, precompressed, precompressedBytes };
}
