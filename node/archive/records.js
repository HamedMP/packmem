import { readFileSync } from "node:fs";
import { compressSync, decompressSync } from "./codec.js";
import { writeAtomic } from "./fs.js";

/**
 * One metadata row per transcript record: type, time, tool, model, tokens and size. Nothing from the transcript
 * beyond tool and model names, so the index holds nothing secret.
 */

const MAX_FIELD = 120;
const MAX_INDEX_FILE = 256 * 1024 * 1024;

const short = (v) => (typeof v === "string" ? v.slice(0, MAX_FIELD) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});

export function indexRow(agent, session, line, value, bytes) {
  const r = obj(value);
  const payload = obj(r.payload);
  const message = obj(r.message);
  const usage = obj(message.usage);
  const ts = short(r.timestamp);
  let type = short(r.type);
  let tool = "";
  if (typeof r.payload === "object" && r.payload !== null) {
    type = `${type}/${short(payload.type)}`.slice(0, MAX_FIELD);
    if (payload.type === "function_call" || payload.type === "custom_tool_call") tool = short(payload.name);
  }
  if (Array.isArray(message.content)) {
    const call = message.content.find((b) => obj(b).type === "tool_use");
    if (call) tool = short(obj(call).name);
  }
  return {
    agent,
    session,
    line,
    type,
    ts,
    day: ts.slice(0, 10),
    tool,
    model: short(message.model) || short(payload.model),
    inTok: num(usage.input_tokens),
    outTok: num(usage.output_tokens),
    bytes,
  };
}

export async function writeRows(path, rows, codec, level) {
  await writeAtomic(path, compressSync(codec, Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n"), "utf8"), level));
}

export function readRows(path, codec) {
  try {
    const text = decompressSync(codec, readFileSync(path), MAX_INDEX_FILE).toString("utf8");
    return text === "" ? [] : text.split("\n").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
