import { createHash, randomBytes } from "node:crypto";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { compressSync, decompressSync } from "./codec.js";
import { FILE_MODE, ensureDir, writeAtomic } from "./fs.js";

/**
 * The shared string store. Each archive run adds one immutable segment: `<name>.pack` holds compressed frames and
 * `<name>.idx` says where every string is. The index is written last, so a segment without one is an interrupted
 * run; it is ignored, and removed by the next run that holds the lock.
 */

const MAX_INDEX_BYTES = 512 * 1024 * 1024;

export function contentHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
}

export class ArchiveCorrupt extends Error {
  name = "ArchiveCorrupt";
}

export class SegmentWriter {
  name = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  #handle = null;
  #written = 0;
  #frames = [];
  #strings = [];
  #groups = new Map();
  #pending = 0;
  #added = new Set();

  constructor(dir, codec, level, frameBytes) {
    this.dir = dir;
    this.codec = codec;
    this.level = level;
    this.frameBytes = frameBytes;
  }

  has(hash) {
    return this.#added.has(hash);
  }

  /** Strings are grouped by the JSON key they sat under, so similar text shares a frame and compresses together. */
  async add(hash, text, group) {
    if (this.#added.has(hash)) return;
    this.#added.add(hash);
    const bytes = Buffer.from(text, "utf8");
    let g = this.#groups.get(group);
    if (!g) this.#groups.set(group, (g = { parts: [], hashes: [], size: 0 }));
    g.parts.push(bytes);
    g.hashes.push(hash);
    g.size += bytes.length;
    this.#pending += bytes.length;
    if (g.size >= this.frameBytes) await this.#flush(group);
    // Bound memory across groups: when everything pending reaches four frames, write out the largest group.
    while (this.#pending >= this.frameBytes * 4) {
      const largest = [...this.#groups.entries()].sort((a, b) => b[1].size - a[1].size)[0];
      if (!largest) break;
      await this.#flush(largest[0]);
    }
  }

  async #flush(group) {
    const g = this.#groups.get(group);
    if (!g || g.parts.length === 0) return;
    this.#groups.delete(group);
    this.#pending -= g.size;
    const frame = this.#frames.length;
    let offset = 0;
    g.parts.forEach((part, i) => {
      this.#strings.push([g.hashes[i], frame, offset, part.length]);
      offset += part.length;
    });
    const packed = compressSync(this.codec, Buffer.concat(g.parts), this.level);
    if (!this.#handle) {
      await ensureDir(this.dir);
      this.#handle = await open(join(this.dir, `${this.name}.pack.tmp`), "wx", FILE_MODE);
    }
    await this.#handle.write(packed, 0, packed.length, this.#written);
    this.#frames.push({ offset: this.#written, compressed: packed.length, size: offset });
    this.#written += packed.length;
  }

  /** Writes the pack, then its index. Returns false when nothing was added. */
  async finish() {
    for (const group of [...this.#groups.keys()]) await this.#flush(group);
    if (!this.#handle) return false;
    await this.#handle.sync().catch(() => undefined);
    await this.#handle.close();
    this.#handle = null;
    await rename(join(this.dir, `${this.name}.pack.tmp`), join(this.dir, `${this.name}.pack`));
    const index = { v: 1, codec: this.codec, frames: this.#frames, strings: this.#strings };
    await writeAtomic(join(this.dir, `${this.name}.idx`), compressSync(this.codec, Buffer.from(JSON.stringify(index)), this.level));
    return true;
  }

  async abort() {
    await this.#handle?.close().catch(() => undefined);
    this.#handle = null;
    await rm(join(this.dir, `${this.name}.pack.tmp`), { force: true });
  }
}

export class PackSet {
  #where = new Map();
  #segments = new Map();
  #handles = new Map();
  #cache = new Map();

  constructor(dir, cacheFrames = 4) {
    this.dir = dir;
    this.cacheFrames = cacheFrames;
  }

  static async load(dir, codec) {
    const set = new PackSet(dir);
    const names = await readdir(dir).catch(() => []);
    for (const file of names.filter((n) => n.endsWith(".idx")).sort()) await set.addSegment(file.slice(0, -4), codec);
    return set;
  }

  async addSegment(name, codec) {
    const path = join(this.dir, `${name}.idx`);
    const info = await stat(path);
    if (info.size > MAX_INDEX_BYTES) throw new ArchiveCorrupt("An archive index is larger than allowed.");
    const handle = await open(path, "r");
    const raw = Buffer.alloc(info.size);
    try {
      await handle.read(raw, 0, info.size, 0);
    } finally {
      await handle.close();
    }
    let index;
    try {
      index = JSON.parse(decompressSync(codec, raw, MAX_INDEX_BYTES).toString("utf8"));
    } catch {
      throw new ArchiveCorrupt("An archive index could not be read.");
    }
    if (index.v !== 1 || index.codec !== codec) throw new ArchiveCorrupt("An archive segment was written with a different format or codec.");
    this.#segments.set(name, { codec: index.codec, frames: index.frames });
    for (const [hash, frame, offset, length] of index.strings) {
      if (!this.#where.has(hash)) this.#where.set(hash, { segment: name, frame, offset, length });
    }
  }

  has(hash) {
    return this.#where.has(hash);
  }

  segmentNames() {
    return [...this.#segments.keys()];
  }

  hashesIn(segment) {
    const out = [];
    for (const [hash, loc] of this.#where) if (loc.segment === segment) out.push(hash);
    return out;
  }

  /** Loads the frames these hashes live in, so `get` can then be called synchronously. */
  async ensure(hashes) {
    const needed = new Set();
    for (const hash of hashes) {
      const loc = this.#where.get(hash);
      if (!loc) throw new ArchiveCorrupt("A string this session needs is missing from the archive.");
      needed.add(`${loc.segment}#${loc.frame}`);
    }
    const capacity = Math.max(this.cacheFrames, needed.size);
    for (const key of needed) {
      if (this.#cache.has(key)) {
        const buf = this.#cache.get(key);
        this.#cache.delete(key);
        this.#cache.set(key, buf);
        continue;
      }
      while (this.#cache.size >= capacity) {
        const oldest = this.#cache.keys().next().value;
        if (needed.has(oldest)) break;
        this.#cache.delete(oldest);
      }
      this.#cache.set(key, await this.#readFrame(key));
    }
  }

  get(hash) {
    const loc = this.#where.get(hash);
    const frame = loc && this.#cache.get(`${loc.segment}#${loc.frame}`);
    if (!loc || !frame) throw new ArchiveCorrupt("A string this session needs is missing from the archive.");
    if (loc.offset + loc.length > frame.length) throw new ArchiveCorrupt("An archive frame is shorter than its index says.");
    return frame.toString("utf8", loc.offset, loc.offset + loc.length);
  }

  async #readFrame(key) {
    const [segment, n] = key.split("#");
    const seg = this.#segments.get(segment);
    const frame = seg?.frames[Number(n)];
    if (!seg || !frame) throw new ArchiveCorrupt("An archive frame is missing.");
    let handle = this.#handles.get(segment);
    if (!handle) {
      handle = await open(join(this.dir, `${segment}.pack`), "r");
      this.#handles.set(segment, handle);
    }
    const buf = Buffer.alloc(frame.compressed);
    const { bytesRead } = await handle.read(buf, 0, frame.compressed, frame.offset);
    if (bytesRead !== frame.compressed) throw new ArchiveCorrupt("An archive pack is truncated.");
    let out;
    try {
      out = decompressSync(seg.codec, buf, frame.size);
    } catch {
      throw new ArchiveCorrupt("An archive frame could not be decompressed.");
    }
    if (out.length !== frame.size) throw new ArchiveCorrupt("An archive frame has the wrong size.");
    return out;
  }

  async close() {
    for (const handle of this.#handles.values()) await handle.close().catch(() => undefined);
    this.#handles.clear();
    this.#cache.clear();
  }
}
