import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
const MAX_JSON_FILE = 64 * 1024 * 1024;

export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is masked by umask and ignored for directories that already exist.
  await chmod(path, DIR_MODE).catch(() => undefined);
}

export function tempPath(path) {
  return `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/** Temp file, fsync, rename: a crash never leaves a half-written file under the real name. */
export async function writeAtomic(path, data) {
  await ensureDir(dirname(path));
  const temp = tempPath(path);
  const handle = await open(temp, "wx", FILE_MODE);
  try {
    await handle.writeFile(data);
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Parsed JSON, or undefined when the file is missing, oversized or not JSON. */
export async function readJson(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_JSON_FILE) return undefined;
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export class ArchiveBusy extends Error {
  name = "ArchiveBusy";
  constructor() {
    super("Another archive run is in progress.");
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** One writer at a time. A lock whose process is gone is stale and is taken over. */
export async function withLock(path, fn) {
  await ensureDir(dirname(path));
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, "wx", FILE_MODE);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt > 0) throw new ArchiveBusy();
      const text = (await readFile(path, "utf8").catch(() => "")).trim();
      const pid = Number(text);
      // An empty lock is another run between creating the file and writing its pid, unless it is old.
      const age = Date.now() - (await stat(path).then((s) => s.mtimeMs).catch(() => 0));
      if (text === "" && age < 60_000) throw new ArchiveBusy();
      if (Number.isInteger(pid) && pid > 0 && (pid === process.pid || alive(pid))) throw new ArchiveBusy();
      await rm(path, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
