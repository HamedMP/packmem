import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, constants as fsc, link, open, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { REF, canonical, collectRefs, fill, strip } from "./canon.js";
import { assertCodec, compressSync, createCompress, createDecompress, defaultCodec } from "./codec.js";
import { FILE_MODE, ensureDir, readJson, tempPath, withLock, writeAtomic } from "./fs.js";
import { ArchiveCorrupt, PackSet, SegmentWriter, contentHash } from "./pack.js";
import { indexRow, readRows, writeRows } from "./records.js";
import { AGENTS, defaultRoots, discover } from "./sources.js";

export { ArchiveCorrupt };
export { ArchiveBusy } from "./fs.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// fatal: invalid UTF-8 throws instead of becoming U+FFFD; ignoreBOM: a leading BOM is kept as a character.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_COMBINED_BYTES = 1024 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const isSafeId = (id) => typeof id === "string" && SAFE_ID.test(id) && !id.includes("..");

export class ArchiveNotFound extends Error {
  name = "ArchiveNotFound";
  constructor(message = "No archived session with that id. `packmem archive list` shows them.") {
    super(message);
  }
}

export class ArchiveTargetExists extends Error {
  name = "ArchiveTargetExists";
  constructor() {
    super("A file already exists where the session would be restored. Pass --to <path> to write it elsewhere.");
  }
}

export class ArchiveForeignDir extends Error {
  name = "ArchiveForeignDir";
  constructor(dir) {
    super(`${dir} is not a packmem archive and is not empty. Choose an empty or new folder with --dir.`);
  }
}

/** Everything the archive writes at its root. Deleting the archive removes these names and nothing else. */
const OWN = ["meta.json", "packs", "sessions", "entries", "index", "index.pm", "tmp"];

async function readMeta(s) {
  const meta = await readJson(s.l.meta);
  return meta && meta.v === 1 && (meta.codec === "zstd" || meta.codec === "brotli") ? meta : null;
}

/**
 * The archive only ever writes into a folder that is missing, empty, or already an archive (a valid meta.json), so a
 * wrong --dir can never mix it into, or let `delete --all` clear, someone's own folder.
 */
async function assertArchiveDir(s, { mustExist = false } = {}) {
  const names = await readdir(s.l.root).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (names === null) {
    if (mustExist) throw new ArchiveNotFound(`No packmem archive at ${s.dir}.`);
    return;
  }
  if (await readMeta(s)) return;
  if (mustExist || names.some((n) => n !== "lock")) throw new ArchiveForeignDir(s.dir);
}

export function defaultDir(env = process.env) {
  return env.PACKMEM_ARCHIVE_DIR?.trim() || join(homedir(), ".packmem", "agent-history");
}

/**
 * config: { dir, roots?: { "claude-code"?: string[], codex?: string[] }, codec?, level?, minStringBytes?,
 * frameBytes?, maxStringBytes?, maxFileBytes?, loadPackmem? }
 */
function settings(config = {}) {
  const dir = config.dir ?? defaultDir();
  return {
    ...config,
    dir,
    min: config.minStringBytes ?? 256,
    // Skeletons are mostly ids, keys and short values; past level 9 they gain little and cost a large context each.
    skeletonLevel: config.skeletonLevel ?? (config.level !== undefined ? Math.min(config.level, 9) : Number(process.env.PACKMEM_ARCHIVE_SKELETON_LEVEL ?? 9)),
    maxString: config.maxStringBytes ?? 16 * 1024 * 1024,
    frameBytes: config.frameBytes ?? 8 * 1024 * 1024,
    maxFile: config.maxFileBytes ?? 4 * 1024 ** 3,
    l: {
      root: dir,
      lock: join(dir, "lock"),
      meta: join(dir, "meta.json"),
      packs: join(dir, "packs"),
      tmp: join(dir, "tmp"),
      combined: join(dir, "index.pm"),
      entry: (a, id) => join(dir, "entries", a, `${id}.json`),
      skeleton: (a, id, sha) => join(dir, "sessions", a, `${id}.${sha.slice(0, 12)}.skel`),
      rows: (a, id, sha) => join(dir, "index", a, `${id}.${sha.slice(0, 12)}.rows`),
    },
  };
}

async function archiveCodec(s) {
  const meta = await readJson(s.l.meta);
  if (meta && (meta.codec === "zstd" || meta.codec === "brotli")) {
    assertCodec(meta.codec);
    return meta.codec;
  }
  return s.codec ?? defaultCodec();
}

function isEntry(e) {
  return (
    !!e &&
    isSafeId(e.id) &&
    AGENTS.includes(e.agent) &&
    typeof e.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(e.sha256) &&
    Array.isArray(e.refs) &&
    Number.isInteger(e.lines) &&
    typeof e.sourcePath === "string" &&
    typeof e.sourceBytes === "number"
  );
}

async function loadEntries(s, agent) {
  const out = [];
  for (const a of AGENTS) {
    if (agent && a !== agent) continue;
    for (const file of await readdir(join(s.l.root, "entries", a)).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      const e = await readJson(join(s.l.root, "entries", a, file));
      if (isEntry(e) && e.agent === a && `${e.id}.json` === file) out.push(e);
    }
  }
  return out;
}

/** Ids come from file names; anything that could escape a directory is replaced by a hash of the path. */
function sessionId(path, taken) {
  const name = basename(path).replace(/\.jsonl$/, "");
  const hash = createHash("sha256").update(path).digest("hex");
  let id = isSafeId(name) ? name : `s-${hash.slice(0, 16)}`;
  const prior = taken.get(id);
  if (prior && prior !== path) id = `${id.slice(0, 180)}-${hash.slice(0, 8)}`;
  return id;
}

/** Splits a byte stream on "\n" exactly, keeping every byte, and reports whether the input ended with a newline. */
async function* lines(stream, end) {
  let carry = [];
  let sawAny = false;
  for await (const chunk of stream) {
    let start = 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
      carry.push(chunk.subarray(start, i));
      yield carry.length === 1 ? carry[0] : Buffer.concat(carry);
      carry = [];
      start = i + 1;
    }
    if (start < chunk.length) carry.push(chunk.subarray(start));
    if (chunk.length > 0) sawAny = true;
  }
  const rest = carry.length === 0 ? Buffer.alloc(0) : Buffer.concat(carry);
  end.newline = sawAny && rest.length === 0;
  if (rest.length > 0) yield rest;
}

async function buildSkeleton(s, ctx, agent, id, file) {
  const before = await stat(file.path).catch(() => null);
  if (!before?.isFile()) return { agent, id, reason: "unreadable" };
  const hash = createHash("sha256");
  const refs = new Set();
  const rows = [];
  const end = { newline: false };
  let read = 0;
  let n = 0;
  let verbatim = 0;
  const source = (async function* () {
    for await (const chunk of createReadStream(file.path)) {
      hash.update(chunk);
      read += chunk.length;
      yield chunk;
    }
  })();
  await ensureDir(s.l.tmp);
  const temp = tempPath(join(s.l.tmp, `${id}.skel`));
  const skeleton = async function* () {
    for await (const raw of lines(source, end)) {
      const sep = n ? "\n" : "";
      const lineNo = n++;
      let text;
      try {
        text = strictUtf8.decode(raw);
      } catch {
        verbatim++;
        yield `${sep}B${raw.toString("base64")}`;
        continue;
      }
      const value = canonical(text);
      const queued = [];
      const stripped =
        value === undefined
          ? undefined
          : strip(value, (str, key) => {
              const size = Buffer.byteLength(str, "utf8");
              if (size < s.min && !str.startsWith(REF)) return null;
              if (size > s.maxString) return null;
              const h = contentHash(str);
              queued.push([h, str, key]);
              return h;
            });
      if (value !== undefined) rows.push(indexRow(agent, id, lineNo, value, raw.length));
      if (stripped === undefined) {
        verbatim++;
        yield `${sep}V${text}`;
        continue;
      }
      for (const [h, str, key] of queued) {
        refs.add(h);
        if (!ctx.packs.has(h)) await ctx.writer.add(h, str, key);
      }
      yield `${sep}J${JSON.stringify(stripped)}`;
    }
    yield `${n ? "\n" : ""}T${JSON.stringify({ lines: n, newline: end.newline })}`;
  };
  try {
    await pipeline(Readable.from(skeleton()), createCompress(ctx.codec, s.skeletonLevel), createWriteStream(temp, { flags: "wx", mode: FILE_MODE }));
  } catch {
    await rm(temp, { force: true });
    return { agent, id, reason: "unreadable" };
  }
  const after = await stat(file.path).catch(() => null);
  if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs || read !== before.size) {
    await rm(temp, { force: true });
    return { agent, id, reason: "changed_while_reading" };
  }
  const rowsTemp = tempPath(join(s.l.tmp, `${id}.rows`));
  await writeRows(rowsTemp, rows, ctx.codec, s.level);
  return { agent, id, file: { ...file, mtimeMs: before.mtimeMs, sizeBytes: before.size }, temp, rowsTemp, sha256: hash.digest("hex"), lines: n, verbatim, refs: [...refs], indexRows: rows.length };
}

/** Streams the original bytes of a session out of the archive, checking line count and sha256 at the end. */
async function replay(packs, codec, skeletonPath, expect, sink) {
  const hash = createHash("sha256");
  const end = { newline: false };
  let n = 0;
  let trailer = null;
  const emit = async (buf) => {
    hash.update(buf);
    await sink(buf);
  };
  try {
    const stream = createReadStream(skeletonPath).pipe(createDecompress(codec));
    for await (const raw of lines(stream, end)) {
      const line = raw.toString("utf8");
      const tag = line[0];
      if (tag === "T") {
        trailer = JSON.parse(line.slice(1));
        continue;
      }
      if (trailer) throw new ArchiveCorrupt("An archived session has data after its end marker.");
      if (n > 0) await emit(Buffer.from("\n"));
      n++;
      if (tag === "B") await emit(Buffer.from(line.slice(1), "base64"));
      else if (tag === "V") await emit(Buffer.from(line.slice(1), "utf8"));
      else if (tag === "J") {
        const value = JSON.parse(line.slice(1));
        const needed = new Set();
        collectRefs(value, needed);
        if (needed.size) await packs.ensure(needed);
        await emit(Buffer.from(JSON.stringify(fill(value, (h) => packs.get(h))), "utf8"));
      } else throw new ArchiveCorrupt("An archived session has a line it does not recognise.");
    }
  } catch (error) {
    if (error instanceof ArchiveCorrupt) throw error;
    throw new ArchiveCorrupt("An archived session could not be read back.");
  }
  if (!trailer || trailer.lines !== n || n !== expect.lines) throw new ArchiveCorrupt("An archived session is incomplete.");
  if (trailer.newline) await emit(Buffer.from("\n"));
  if (hash.digest("hex") !== expect.sha256) throw new ArchiveCorrupt("An archived session does not match the original.");
}

async function sweep(s) {
  await rm(s.l.tmp, { recursive: true, force: true });
  for (const name of await readdir(s.l.packs).catch(() => [])) {
    if (name.endsWith(".tmp")) await rm(join(s.l.packs, name), { force: true });
    if (name.endsWith(".pack") && !(await stat(join(s.l.packs, `${name.slice(0, -5)}.idx`)).catch(() => null))) await rm(join(s.l.packs, name), { force: true });
  }
}

async function dirBytes(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(path);
    else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function loadPackmem(s) {
  if (s.loadPackmem) return s.loadPackmem().catch(() => null);
  try {
    const pm = await import("../index.js");
    return typeof pm.from === "function" && typeof pm.Table?.fromBytes === "function" ? pm : null;
  } catch {
    return null;
  }
}

async function rebuildCombined(s, codec, entries) {
  const pm = await loadPackmem(s);
  if (!pm || entries.length === 0) {
    await rm(s.l.combined, { force: true });
    return;
  }
  function* rows() {
    for (const e of entries) yield* readRows(s.l.rows(e.agent, e.id, e.sha256), codec);
  }
  await writeAtomic(s.l.combined, pm.from(rows()).toBytes());
}

/** Size of the planned files after zstd level 3 (Brotli 5 without zstd), measured on up to 64 MB sampled from them. */
async function estimate(codec, files) {
  const budget = 64 * 1024 * 1024;
  const total = files.reduce((n, f) => n + f.sizeBytes, 0);
  if (total === 0) return { estimatedBytes: 0, sampledBytes: 0 };
  const per = Math.max(64 * 1024, Math.floor(budget / Math.max(1, files.length)));
  let raw = 0;
  let packed = 0;
  for (const f of files) {
    if (raw >= budget) break;
    const take = Math.min(f.sizeBytes, per);
    const handle = await open(f.path, "r").catch(() => null);
    if (!handle) continue;
    try {
      const buf = Buffer.alloc(take);
      const { bytesRead } = await handle.read(buf, 0, take, Math.max(0, Math.floor((f.sizeBytes - take) / 2)));
      raw += bytesRead;
      packed += compressSync(codec, buf.subarray(0, bytesRead), codec === "zstd" ? 3 : 5).length;
    } finally {
      await handle.close();
    }
  }
  return { estimatedBytes: raw ? Math.round((total * packed) / raw) : 0, sampledBytes: raw };
}

/** Archives sessions. Never deletes or changes an agent's own files. */
export async function archive(config = {}, options = {}) {
  const s = settings(config);
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - (options.olderThanDays ?? 1) * DAY_MS;
  const run = async () => {
    const codec = await archiveCodec(s);
    const entries = await loadEntries(s);
    const byPath = new Map(entries.map((e) => [`${e.agent}:${e.sourcePath}`, e]));
    const result = { dryRun: !!options.dryRun, roots: {}, planned: [], archived: 0, skipped: [], failed: [], precompressed: 0, precompressedBytes: 0, sourceBytes: 0, addedBytes: 0 };
    const todo = [];
    for (const agent of AGENTS) {
      if (options.agent && agent !== options.agent) continue;
      const found = await discover(agent, s.roots?.[agent] ?? defaultRoots(agent));
      result.roots[agent] = found.roots;
      result.precompressed += found.precompressed;
      result.precompressedBytes += found.precompressedBytes;
      const taken = new Map(entries.filter((e) => e.agent === agent).map((e) => [e.id, e.sourcePath]));
      for (const file of found.files.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
        const prior = byPath.get(`${agent}:${file.path}`);
        const id = prior?.id ?? sessionId(file.path, taken);
        taken.set(id, file.path);
        const skip = (reason) => result.skipped.push({ agent, id, reason });
        if (file.sizeBytes > s.maxFile) skip("too_large");
        else if (file.mtimeMs > cutoff) skip("too_recent");
        else if (prior && prior.sourceBytes === file.sizeBytes && prior.sourceMtimeMs === file.mtimeMs) skip("unchanged");
        else todo.push({ agent, id, file, prior });
      }
    }
    const chosen = todo.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs).slice(0, options.maxSessions ?? Infinity);
    result.planned = chosen.map((t) => ({ agent: t.agent, id: t.id, sizeBytes: t.file.sizeBytes, reason: t.prior ? "changed" : "new" }));
    if (options.dryRun) return { ...result, ...(await estimate(codec, chosen.map((t) => t.file))) };
    if (chosen.length === 0) return result;

    await ensureDir(s.l.root);
    const startBytes = await dirBytes(s.l.root);
    await writeAtomic(s.l.meta, JSON.stringify({ v: 1, codec }));
    await sweep(s);
    const packs = await PackSet.load(s.l.packs, codec);
    const ctx = { codec, packs, writer: new SegmentWriter(s.l.packs, codec, s.level, s.frameBytes) };
    const built = [];
    let replaced = false;
    try {
      for (const t of chosen) {
        const b = await buildSkeleton(s, ctx, t.agent, t.id, t.file);
        if (b.temp) built.push({ ...b, prior: t.prior });
        else result.skipped.push(b);
      }
      if (await ctx.writer.finish()) await packs.addSegment(ctx.writer.name, codec);
      for (const b of built) {
        try {
          await replay(packs, codec, b.temp, b, async () => undefined);
        } catch (error) {
          result.failed.push({ agent: b.agent, id: b.id, reason: error.message });
          await rm(b.temp, { force: true });
          await rm(b.rowsTemp, { force: true });
          continue;
        }
        const skeletonFile = s.l.skeleton(b.agent, b.id, b.sha256);
        await ensureDir(dirname(skeletonFile));
        await rename(b.temp, skeletonFile);
        await ensureDir(dirname(s.l.rows(b.agent, b.id, b.sha256)));
        await rename(b.rowsTemp, s.l.rows(b.agent, b.id, b.sha256));
        const entry = {
          v: 1,
          agent: b.agent,
          id: b.id,
          sourcePath: b.file.path,
          sourceBytes: b.file.sizeBytes,
          sourceMtimeMs: b.file.mtimeMs,
          sha256: b.sha256,
          lines: b.lines,
          verbatimLines: b.verbatim,
          archivedAt: new Date().toISOString(),
          codec,
          skeletonBytes: (await stat(skeletonFile)).size,
          refs: b.refs,
          indexRows: b.indexRows,
        };
        await writeAtomic(s.l.entry(b.agent, b.id), JSON.stringify(entry));
        if (b.prior && b.prior.sha256 !== b.sha256) {
          replaced = true;
          await rm(s.l.skeleton(b.prior.agent, b.prior.id, b.prior.sha256), { force: true });
          await rm(s.l.rows(b.prior.agent, b.prior.id, b.prior.sha256), { force: true });
        }
        result.archived++;
        result.sourceBytes += b.file.sizeBytes;
      }
    } catch (error) {
      await ctx.writer.abort();
      for (const b of built) await rm(b.temp, { force: true });
      throw error;
    } finally {
      await packs.close();
    }
    // A session that changed may no longer use some of its earlier strings; drop those now rather than at a delete.
    if (replaced) await collectGarbage(s, codec, await loadEntries(s));
    await rebuildCombined(s, codec, await loadEntries(s));
    result.addedBytes = Math.max(0, (await dirBytes(s.l.root)) - startBytes);
    return result;
  };
  await assertArchiveDir(s);
  return options.dryRun ? run() : withLock(s.l.lock, run);
}

export async function status(config = {}) {
  const s = settings(config);
  const entries = await loadEntries(s);
  const codec = await archiveCodec(s).catch(() => defaultCodec());
  const byAgent = {};
  let sourceBytes = 0;
  for (const e of entries) {
    const a = (byAgent[e.agent] ??= { sessions: 0, sourceBytes: 0 });
    a.sessions++;
    a.sourceBytes += e.sourceBytes;
    sourceBytes += e.sourceBytes;
  }
  const archiveBytes = entries.length ? await dirBytes(s.l.root) : 0;
  const times = entries.map((e) => e.sourceMtimeMs).sort((a, b) => a - b);
  return {
    dir: s.dir,
    sessions: entries.length,
    sourceBytes,
    archiveBytes,
    ratio: archiveBytes ? Math.round((sourceBytes / archiveBytes) * 100) / 100 : null,
    codec,
    index: (await loadPackmem(s)) ? "packmem" : "rows",
    byAgent,
    oldest: times.length ? new Date(times[0]).toISOString() : null,
    newest: times.length ? new Date(times[times.length - 1]).toISOString() : null,
  };
}

export async function list(config = {}, options = {}) {
  const entries = (await loadEntries(settings(config), options.agent)).sort((a, b) => b.sourceMtimeMs - a.sourceMtimeMs);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(Math.max(1, options.limit ?? 50), 100_000);
  return {
    total: entries.length,
    sessions: entries.slice(offset, offset + limit).map((e) => ({
      agent: e.agent,
      id: e.id,
      sourceBytes: e.sourceBytes,
      lines: e.lines,
      modified: new Date(e.sourceMtimeMs).toISOString(),
      archivedAt: e.archivedAt,
      originalPresent: null,
    })),
  };
}

async function findEntry(s, agent, id) {
  if (!AGENTS.includes(agent) || !isSafeId(id)) throw new ArchiveNotFound();
  const e = await readJson(s.l.entry(agent, id));
  if (!isEntry(e) || e.agent !== agent || e.id !== id) throw new ArchiveNotFound();
  return e;
}

/** Puts `temp` at `target` only if nothing is there, atomically: no window between the check and the write. */
async function placeExclusive(temp, target) {
  try {
    await link(temp, target);
  } catch (error) {
    if (error.code === "EEXIST") throw new ArchiveTargetExists();
    if (!["EPERM", "ENOTSUP", "EXDEV", "ENOSYS", "EINVAL"].includes(error.code)) throw error;
    try {
      await copyFile(temp, target, fsc.COPYFILE_EXCL);
    } catch (copyError) {
      if (copyError.code === "EEXIST") throw new ArchiveTargetExists();
      throw copyError;
    }
  }
}

async function replayTo(s, entry, target) {
  const codec = await archiveCodec(s);
  const packs = await PackSet.load(s.l.packs, codec);
  const temp = tempPath(target);
  let bytes = 0;
  try {
    await ensureDir(dirname(target));
    const out = createWriteStream(temp, { flags: "wx", mode: FILE_MODE });
    const done = new Promise((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    });
    await replay(packs, codec, s.l.skeleton(entry.agent, entry.id, entry.sha256), entry, async (chunk) => {
      bytes += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    });
    out.end();
    await done;
    await placeExclusive(temp, target);
    return bytes;
  } finally {
    await rm(temp, { force: true });
    await packs.close();
  }
}

/** Re-reads archived sessions and checks each against the sha256 taken from its original. */
export async function verify(config = {}, target = "all") {
  const s = settings(config);
  const entries = target === "all" ? await loadEntries(s) : [await findEntry(s, target.agent, target.id)];
  const codec = await archiveCodec(s);
  const packs = await PackSet.load(s.l.packs, codec);
  const bad = [];
  let bytes = 0;
  try {
    for (const e of entries) {
      try {
        await replay(packs, codec, s.l.skeleton(e.agent, e.id, e.sha256), e, async (c) => {
          bytes += c.length;
        });
      } catch (error) {
        if (!(error instanceof ArchiveCorrupt)) throw error;
        bad.push({ agent: e.agent, id: e.id, reason: error.message });
      }
    }
  } finally {
    await packs.close();
  }
  if (target !== "all" && bad.length) throw new ArchiveCorrupt(bad[0].reason);
  return { sessions: entries.length, bytes, bad };
}

/** Writes the original bytes back: to the original path only when nothing is there now. Never overwrites. */
export async function restore(config = {}, agent, id, options = {}) {
  const s = settings(config);
  const entry = await findEntry(s, agent, id);
  const target = options.to ?? entry.sourcePath;
  if (await stat(target).catch(() => null)) throw new ArchiveTargetExists();
  return { path: target, bytes: await replayTo(s, entry, target) };
}

/** Deletes archived copies (never an agent's own file) and rewrites packs so their unshared strings leave the disk. */
export async function remove(config = {}, target) {
  const s = settings(config);
  await assertArchiveDir(s, { mustExist: true });
  const result = await withLock(s.l.lock, async () => {
    if (target === "all") {
      if (!(await readMeta(s))) throw new ArchiveForeignDir(s.dir);
      const n = (await loadEntries(s)).length;
      for (const name of OWN) await rm(join(s.l.root, name), { recursive: true, force: true });
      return { removed: n };
    }
    const e = await findEntry(s, target.agent, target.id);
    await rm(s.l.entry(e.agent, e.id), { force: true });
    await rm(s.l.skeleton(e.agent, e.id, e.sha256), { force: true });
    await rm(s.l.rows(e.agent, e.id, e.sha256), { force: true });
    const remaining = await loadEntries(s);
    const codec = await archiveCodec(s);
    await collectGarbage(s, codec, remaining);
    await rebuildCombined(s, codec, remaining);
    return { removed: 1 };
  });
  // Only an empty folder goes, so anything else that was in it stays.
  if (target === "all") await rmdir(s.l.root).catch(() => undefined);
  return result;
}

async function collectGarbage(s, codec, remaining) {
  const live = new Set(remaining.flatMap((e) => e.refs));
  const packs = await PackSet.load(s.l.packs, codec);
  try {
    for (const segment of packs.segmentNames()) {
      const hashes = packs.hashesIn(segment);
      const keep = hashes.filter((h) => live.has(h));
      if (keep.length === hashes.length) continue;
      if (keep.length) {
        const writer = new SegmentWriter(s.l.packs, codec, s.level, s.frameBytes);
        for (const h of keep) {
          await packs.ensure([h]);
          await writer.add(h, packs.get(h), "");
        }
        await writer.finish();
      }
      await rm(join(s.l.packs, `${segment}.idx`), { force: true });
      await rm(join(s.l.packs, `${segment}.pack`), { force: true });
    }
  } finally {
    await packs.close();
  }
}

/** History-wide counts from the record index, read in place by packmem; no session is decompressed. */
export async function query(config = {}, q = {}) {
  const s = settings(config);
  const filter = q.agent ? { agent: q.agent } : undefined;
  const pm = await loadPackmem(s);
  const size = (await stat(s.l.combined).catch(() => null))?.size ?? 0;
  if (pm && size > 0 && size <= MAX_COMBINED_BYTES) {
    try {
      const table = pm.Table.fromBytes(await readFile(s.l.combined));
      const groups = q.groupBy ? Object.entries(table.groupCount(q.groupBy, filter)) : [];
      return { engine: "packmem", rows: filter ? table.count(filter) : table.length, groups: top(groups), sum: q.sum ? table.sum(q.sum, filter) : null };
    } catch {
      // Fall through to the per-session rows.
    }
  }
  const codec = await archiveCodec(s).catch(() => defaultCodec());
  const groups = new Map();
  let rows = 0;
  let sum = 0;
  for (const e of await loadEntries(s, q.agent)) {
    for (const row of readRows(s.l.rows(e.agent, e.id, e.sha256), codec)) {
      rows++;
      if (q.groupBy) groups.set(String(row[q.groupBy]), (groups.get(String(row[q.groupBy])) ?? 0) + 1);
      if (q.sum) sum += row[q.sum];
    }
  }
  return { engine: "rows", rows, groups: top([...groups.entries()]), sum: q.sum ? sum : null };
}

function top(groups) {
  return groups
    .map(([k, v]) => [k, Number(v)])
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 50)
    .map(([key, count]) => ({ key, count }));
}
