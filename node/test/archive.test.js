// The agent-history archive: synthetic sessions only. Never put a real transcript, path or username in this file.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "../archive/archive.js";
import { run } from "../archive/cli.js";
import { zstdAvailable } from "../archive/codec.js";
import { PackSet, contentHash } from "../archive/pack.js";

const OLD = new Date("2026-01-01T00:00:00Z");
const NOW = new Date("2026-03-01T00:00:00Z");
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz012345";
const rec = (o) => JSON.stringify(o);

let dir, roots, home;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pm-archive-"));
  home = join(dir, "archive");
  roots = { "claude-code": [join(dir, "claude", "projects")], codex: [join(dir, "codex", "sessions")] };
  await mkdir(roots["claude-code"][0], { recursive: true });
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const config = (extra = {}) => ({ dir: home, roots, level: 3, ...extra });

async function session(name, body, agent = "claude-code", when = OLD) {
  const folder = join(roots[agent][0], "proj");
  await mkdir(folder, { recursive: true });
  const path = join(folder, `${name}.jsonl`);
  await writeFile(path, body);
  await utimes(path, when, when);
  return path;
}

async function allPaths(path) {
  const out = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...(await allPaths(p)));
  }
  return out;
}

test("gives back every session byte for byte, including lines it cannot re-serialise", async () => {
  const files = {
    plain: [rec({ type: "user", message: { content: "hello ".repeat(100) } }), rec({ type: "assistant", n: 1 })].join("\n") + "\n",
    messy: ["not json at all", '{"a": 1}', '{"n":1.0}', '{"2":0,"b":1}', "", rec({ __proto__x: 1, s: "\u0000starts with nul" })].join("\n"),
    huge: rec({ type: "tool", output: "x".repeat(3 * 1024 * 1024) + "é" }) + "\n",
    bytes: Buffer.concat([Buffer.from(rec({ ok: true }) + "\n"), Buffer.from([0xff, 0xfe, 0x41]), Buffer.from("\n")]),
    empty: "",
    newline: "\n",
  };
  for (const [name, body] of Object.entries(files)) await session(name, body);
  const result = await api.archive(config(), { now: NOW });
  assert.deepEqual(result.failed, []);
  assert.equal(result.archived, Object.keys(files).length);
  for (const [name, body] of Object.entries(files)) {
    const out = join(dir, `${name}.restored`);
    await api.restore(config(), "claude-code", name, { to: out });
    assert.ok((await readFile(out)).equals(Buffer.isBuffer(body) ? body : Buffer.from(body)), name);
  }
});

test("archives Claude Code subagent transcripts and Codex sessions, and leaves Codex's own .jsonl.zst alone", async () => {
  const sub = join(roots["claude-code"][0], "proj", "parent", "subagents");
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, "agent-1.jsonl"), rec({ type: "user", text: "sub" }) + "\n");
  await utimes(join(sub, "agent-1.jsonl"), OLD, OLD);
  await mkdir(roots.codex[0], { recursive: true });
  await session("rollout-1", rec({ type: "response_item", payload: { type: "message" } }) + "\n", "codex");
  await writeFile(join(roots.codex[0], "proj", "rollout-2.jsonl.zst"), randomBytes(100));
  const r = await api.archive(config(), { now: NOW });
  assert.equal(r.archived, 2);
  assert.equal(r.precompressed, 1);
  assert.deepEqual((await api.list(config())).sessions.map((s) => `${s.agent}/${s.id}`).sort(), ["claude-code/agent-1", "codex/rollout-1"]);
});

test("stores a long string shared by two sessions once", async () => {
  const shared = randomBytes(600 * 1024).toString("base64");
  await session("a", rec({ type: "attachment", text: shared }) + "\n");
  await api.archive(config(), { now: NOW });
  const first = (await api.status(config())).archiveBytes;
  await session("b", rec({ type: "attachment", text: shared, other: 1 }) + "\n");
  await api.archive(config(), { now: NOW });
  const second = (await api.status(config())).archiveBytes;
  assert.ok(first > 600 * 1024);
  assert.ok(second - first < 40 * 1024, `second session added ${second - first} bytes`);
});

test("a dry run writes nothing and estimates the size", async () => {
  await session("a", rec({ a: "z".repeat(5000) }) + "\n");
  const r = await api.archive(config(), { now: NOW, dryRun: true });
  assert.equal(r.planned.length, 1);
  assert.ok(r.estimatedBytes > 0 && r.estimatedBytes < 5000);
  await assert.rejects(stat(home));
});

test("leaves sessions that are still being written alone", async () => {
  await session("live", rec({ a: 1 }) + "\n", "claude-code", new Date(NOW.getTime() - 60_000));
  const r = await api.archive(config(), { now: NOW });
  assert.equal(r.archived, 0);
  assert.deepEqual(r.skipped, [{ agent: "claude-code", id: "live", reason: "too_recent" }]);
});

test("never touches the agent's own transcript", async () => {
  const path = await session("a", rec({ a: "y".repeat(500) }) + "\n");
  const before = await stat(path);
  await api.archive(config(), { now: NOW });
  await api.remove(config(), "all");
  const after = await stat(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(path, "utf8"), rec({ a: "y".repeat(500) }) + "\n");
});

test("re-archives a session that grew, and skips one that did not change", async () => {
  const path = await session("a", rec({ n: 1 }) + "\n");
  await api.archive(config(), { now: NOW });
  assert.equal((await api.archive(config(), { now: NOW })).skipped[0]?.reason, "unchanged");
  await writeFile(path, rec({ n: 1 }) + "\n" + rec({ n: 2 }) + "\n");
  await utimes(path, OLD, new Date(OLD.getTime() + 1000));
  assert.equal((await api.archive(config(), { now: NOW })).planned[0]?.reason, "changed");
  const out = join(dir, "a.out");
  await api.restore(config(), "claude-code", "a", { to: out });
  assert.equal(await readFile(out, "utf8"), rec({ n: 1 }) + "\n" + rec({ n: 2 }) + "\n");
});

test("reports a damaged pack instead of serving wrong bytes", async () => {
  await session("a", rec({ text: randomBytes(4096).toString("hex") }) + "\n");
  await api.archive(config(), { now: NOW });
  const packs = join(home, "packs");
  const pack = (await readdir(packs)).find((n) => n.endsWith(".pack"));
  const bytes = await readFile(join(packs, pack));
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  await writeFile(join(packs, pack), bytes);
  assert.equal((await api.verify(config())).bad.length, 1);
  const out = join(dir, "a.out");
  await assert.rejects(api.restore(config(), "claude-code", "a", { to: out }), api.ArchiveCorrupt);
  await assert.rejects(stat(out));
});

test("keeps every archive file private", { skip: process.platform === "win32" && "POSIX modes" }, async () => {
  await session("a", rec({ t: "z".repeat(400) }) + "\n");
  await api.archive(config(), { now: NOW });
  for (const path of [home, ...(await allPaths(home))]) assert.equal((await stat(path)).mode & 0o077, 0, path);
});

test("never prints transcript text from status, list, stats or archive", async () => {
  await session("a", rec({ type: "user", text: `export GITHUB_TOKEN=${SECRET}`, pad: "p".repeat(300) }) + "\n");
  const results = [await api.archive(config(), { now: NOW }), await api.status(config()), await api.list(config()), await api.query(config(), { groupBy: "type" })];
  for (const r of results) assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("restores to the original path only when nothing is there", async () => {
  const path = await session("a", rec({ a: 1 }) + "\n");
  await api.archive(config(), { now: NOW });
  await assert.rejects(api.restore(config(), "claude-code", "a"), api.ArchiveTargetExists);
  await rm(path);
  assert.equal((await api.restore(config(), "claude-code", "a")).path, path);
  assert.equal(await readFile(path, "utf8"), rec({ a: 1 }) + "\n");
});

test("deleting a session removes its own strings from disk and keeps shared ones", async () => {
  const shared = "s".repeat(1000);
  const unique = randomBytes(2000).toString("hex");
  await session("a", rec({ shared, unique }) + "\n");
  await session("b", rec({ shared }) + "\n");
  await api.archive(config(), { now: NOW });
  await api.remove(config(), { agent: "claude-code", id: "a" });
  const packs = await PackSet.load(join(home, "packs"), zstdAvailable() ? "zstd" : "brotli");
  assert.equal(packs.has(contentHash(unique)), false);
  assert.equal(packs.has(contentHash(shared)), true);
  await packs.close();
  assert.equal((await api.verify(config())).bad.length, 0);
  assert.equal((await api.list(config())).total, 1);
});

test("lets only one run write at a time", async () => {
  for (let i = 0; i < 5; i++) await session(`s${i}`, rec({ i, t: randomBytes(3000).toString("hex") }) + "\n");
  const runs = await Promise.allSettled([api.archive(config(), { now: NOW }), api.archive(config(), { now: NOW })]);
  assert.equal(runs.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(runs.find((r) => r.status === "rejected").reason instanceof api.ArchiveBusy);
  assert.equal((await api.verify(config())).bad.length, 0);
});

test("ignores what an interrupted run left behind", async () => {
  await session("a", rec({ t: "q".repeat(500) }) + "\n");
  await api.archive(config(), { now: NOW });
  await writeFile(join(home, "packs", "zzzz-dead.pack"), randomBytes(100));
  await writeFile(join(home, "packs", "zzzz-half.pack.tmp"), randomBytes(100));
  await session("b", rec({ t: "r".repeat(500) }) + "\n");
  await api.archive(config(), { now: NOW });
  assert.deepEqual((await readdir(join(home, "packs"))).filter((n) => n.startsWith("zzzz")), []);
  assert.equal((await api.verify(config())).bad.length, 0);
});

test("works with Brotli where node:zlib has no zstd (Node 20)", async () => {
  const body = [rec({ type: "user", text: "w".repeat(2000) }), "broken {", rec({ n: 2 })].join("\n") + "\n";
  await session("a", body);
  await api.archive(config({ codec: "brotli" }), { now: NOW });
  assert.equal((await api.status(config())).codec, "brotli");
  const out = join(dir, "a.out");
  await api.restore(config(), "claude-code", "a", { to: out });
  assert.equal(await readFile(out, "utf8"), body);
});

test("answers history-wide questions from the packmem index, and from per-session rows without it", async () => {
  await session("a", [rec({ type: "assistant", timestamp: "2026-01-01T10:00:00Z", message: { model: "m1", usage: { input_tokens: 5, output_tokens: 7 }, content: [{ type: "tool_use", name: "Bash" }] } }), rec({ type: "user" })].join("\n") + "\n");
  await mkdir(roots.codex[0], { recursive: true });
  await session("r", rec({ type: "response_item", timestamp: "2026-01-02T00:00:00Z", payload: { type: "function_call", name: "exec" } }) + "\n", "codex");
  await api.archive(config(), { now: NOW });
  for (const cfg of [config(), config({ loadPackmem: async () => null })]) {
    const r = await api.query(cfg, { groupBy: "tool", sum: "outTok" });
    assert.equal(r.engine, cfg.loadPackmem ? "rows" : "packmem");
    assert.equal(r.rows, 3);
    assert.equal(r.sum, 7);
    assert.deepEqual(r.groups.filter((g) => g.key).sort((a, b) => a.key.localeCompare(b.key)), [{ key: "Bash", count: 1 }, { key: "exec", count: 1 }]);
    assert.equal((await api.query(cfg, { agent: "codex" })).rows, 1);
  }
});

test("command line: dry run, archive, status, restore, delete", async () => {
  const path = await session("s1", rec({ type: "user", text: `key ${SECRET}`, pad: "p".repeat(400) }) + "\n");
  const original = await readFile(path);
  let out = "", err = "";
  const io = { out: (t) => (out += t), err: (t) => (err += t), env: {}, now: () => NOW, roots };
  const cli = (...argv) => run([...argv, "--dir", home], io);
  assert.equal(await cli("--dry-run"), 0);
  assert.match(out, /Would archive 1 sessions/);
  await assert.rejects(stat(home));
  assert.equal(await cli(), 0);
  assert.equal(await cli("status"), 0);
  assert.match(out, /1 sessions archived/);
  assert.equal(await cli("verify"), 0);
  assert.equal(await cli("restore", "claude-code/s1"), 1);
  assert.match(err, /already exists/);
  await rm(path);
  assert.equal(await cli("restore", "claude-code/s1"), 0);
  assert.ok((await readFile(path)).equals(original));
  assert.equal(await cli("delete", "--all"), 2);
  assert.equal(await cli("delete", "--all", "--yes"), 0);
  assert.equal(await cli("restore", "nope"), 2);
  assert.ok(!(out + err).includes(SECRET));
});

test("keeps a byte-order mark and invalid UTF-8 exactly", async () => {
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rec({ a: "é" }) + "\n"), Buffer.from([0xc3, 0x28, 0x0a]), Buffer.from(rec({ b: 1 }))]);
  await session("bom", body);
  await api.archive(config(), { now: NOW });
  const out = join(dir, "bom.out");
  await api.restore(config(), "claude-code", "bom", { to: out });
  assert.ok((await readFile(out)).equals(body));
});

test("delete --all never removes anything the archive did not write", async () => {
  const foreign = join(dir, "notes");
  await mkdir(join(foreign, "sub"), { recursive: true });
  await writeFile(join(foreign, "thesis.md"), "mine");
  await writeFile(join(foreign, "sub", "precious.txt"), "mine too");
  await assert.rejects(api.remove({ dir: foreign, roots }, "all"), api.ArchiveForeignDir);
  assert.equal(await readFile(join(foreign, "thesis.md"), "utf8"), "mine");
  assert.equal(await readFile(join(foreign, "sub", "precious.txt"), "utf8"), "mine too");
  let err = "";
  const io = { out: () => {}, err: (t) => (err += t), env: {}, now: () => NOW, roots };
  assert.equal(await run(["delete", "--all", "--yes", "--dir", foreign], io), 1);
  assert.match(err, /not a packmem archive/);
  assert.equal(await readFile(join(foreign, "thesis.md"), "utf8"), "mine");

  await session("a", rec({ a: "k".repeat(400) }) + "\n");
  await api.archive(config(), { now: NOW });
  await writeFile(join(home, "README-mine.txt"), "put here by hand");
  await api.remove(config(), "all");
  assert.deepEqual(await readdir(home), ["README-mine.txt"]);
  await rm(join(home, "README-mine.txt"));
  await session("b", rec({ b: 1 }) + "\n");
  await api.archive(config(), { now: NOW });
  await api.remove(config(), "all");
  await assert.rejects(stat(home));
});

test("refuses to archive into a folder that is not empty and is not an archive", async () => {
  await session("a", rec({ a: 1 }) + "\n");
  const foreign = join(dir, "documents");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "letter.txt"), "mine");
  await assert.rejects(api.archive({ dir: foreign, roots }, { now: NOW }), api.ArchiveForeignDir);
  await assert.rejects(api.archive({ dir: foreign, roots }, { now: NOW, dryRun: true }), api.ArchiveForeignDir);
  assert.deepEqual(await readdir(foreign), ["letter.txt"]);
});

test("a session that changed no longer keeps its old text in the archive", async () => {
  const old = randomBytes(2000).toString("hex");
  const path = await session("a", rec({ old }) + "\n");
  await api.archive(config(), { now: NOW });
  await writeFile(path, rec({ fresh: "f".repeat(600) }) + "\n");
  await utimes(path, OLD, new Date(OLD.getTime() + 5000));
  await api.archive(config(), { now: NOW });
  const packs = await PackSet.load(join(home, "packs"), zstdAvailable() ? "zstd" : "brotli");
  assert.equal(packs.has(contentHash(old)), false);
  await packs.close();
  assert.equal((await api.verify(config())).bad.length, 0);
});

test("restore does not overwrite a file that appears at the target", async () => {
  const path = await session("a", rec({ a: 1 }) + "\n");
  await api.archive(config(), { now: NOW });
  const target = join(dir, "taken.jsonl");
  await writeFile(target, "someone else's");
  await assert.rejects(api.restore(config(), "claude-code", "a", { to: target }), api.ArchiveTargetExists);
  assert.equal(await readFile(target, "utf8"), "someone else's");
  assert.deepEqual((await readdir(dir)).filter((n) => n.includes(".tmp")), []);
  assert.ok(path);
});

test("deleting from a folder that does not exist says there is no archive there", async () => {
  let err = "";
  const io = { out: () => {}, err: (t) => (err += t), env: {}, now: () => NOW, roots };
  assert.equal(await run(["delete", "--all", "--yes", "--dir", join(dir, "nowhere")], io), 1);
  assert.match(err, /No packmem archive at/);
});
