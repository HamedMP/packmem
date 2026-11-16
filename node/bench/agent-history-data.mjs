// Synthetic Claude Code and Codex transcripts with the redundancy real ones show, for the archive benchmark.
// Nothing here comes from a real transcript. Usage: node bench/agent-history-data.mjs <out-dir> [scale]
// What it imitates, from measurements on real history: tool results stored twice (message and toolUseResult),
// the same files read again after small edits, reminder and skill blocks repeated in every session, Codex items
// mirrored as item_completed events, and incompressible encrypted reasoning blobs.
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
const scale = Number(process.argv[3] ?? 1);
if (!out) throw new Error("usage: agent-history-data.mjs <out-dir> [scale]");

let seed = 42;
// mulberry32: integer math only, so the sequence is the same on every platform.
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rand() * a.length)];
const WORDS = "the a to of and in is it for on with that this as be are was by at or an from not but can if will have has use file test run build fix error value table column row data type return function const let import export async await new string number list map set get add remove update check write read open close load save parse query filter group sum count index key name path line text json node python rust memory packed record field".split(" ");
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const b64 = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256))).toString("base64");
const uuid = () => [8, 4, 4, 4, 12].map((n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("")).join("-");

// A pool of source files that sessions read, edit and read again.
const files = Array.from({ length: 300 }, (_, i) => ({
  path: `/work/project-${i % 12}/src/module_${i}.ts`,
  text: Array.from({ length: 40 + Math.floor(rand() * 200) }, (_, l) => `  ${pick(["const", "let", "return", "if", "export"])} ${sentence(6)}; // ${l}`).join("\n"),
}));
const edit = (f) => {
  const lines = f.text.split("\n");
  lines[Math.floor(rand() * lines.length)] = `  const ${sentence(5)};`;
  f.text = lines.join("\n");
};
const reminder = `<system-reminder>\n${Array.from({ length: 120 }, () => `- ${sentence(14)}`).join("\n")}\n</system-reminder>`;
const skills = Array.from({ length: 200 }, (_, i) => `- skill-${i}: ${sentence(18)}`).join("\n");

function claudeSession(n) {
  const sid = uuid();
  const rows = [];
  let t = Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000;
  const ts = () => new Date((t += 1000 + Math.floor(rand() * 20_000))).toISOString();
  rows.push({ type: "attachment", sessionId: sid, timestamp: ts(), attachment: { type: "skill_listing", content: skills } });
  const turns = 20 + Math.floor(rand() * 60);
  for (let i = 0; i < turns; i++) {
    rows.push({ type: "user", sessionId: sid, uuid: uuid(), timestamp: ts(), message: { role: "user", content: `${sentence(12)}\n${i % 7 === 0 ? reminder : ""}` } });
    const f = pick(files);
    if (rand() < 0.3) edit(f);
    const id = `toolu_${uuid()}`;
    rows.push({ type: "assistant", sessionId: sid, uuid: uuid(), timestamp: ts(), message: { role: "assistant", model: "model-a", usage: { input_tokens: 10, output_tokens: 200 }, content: [{ type: "text", text: sentence(40) }, { type: "tool_use", id, name: pick(["Read", "Bash", "Edit", "Grep"]), input: { file_path: f.path } }] } });
    rows.push({ type: "user", sessionId: sid, uuid: uuid(), timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: f.text }] }, toolUseResult: { type: "text", file: { filePath: f.path, content: f.text } } });
  }
  return rows;
}

function codexSession(n) {
  const rows = [];
  let t = Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000;
  const ts = () => new Date((t += 1000 + Math.floor(rand() * 20_000))).toISOString();
  rows.push({ timestamp: ts(), type: "session_meta", payload: { id: uuid(), cwd: "/work/project", base_instructions: { text: skills } } });
  const turns = 20 + Math.floor(rand() * 60);
  for (let i = 0; i < turns; i++) {
    const f = pick(files);
    if (rand() < 0.3) edit(f);
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: sentence(50) }] };
    rows.push({ timestamp: ts(), type: "response_item", payload: item });
    rows.push({ timestamp: ts(), type: "event_msg", payload: { type: "item_completed", item } });
    rows.push({ timestamp: ts(), type: "response_item", payload: { type: "reasoning", encrypted_content: b64(1500) } });
    rows.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name: "exec", arguments: JSON.stringify({ cmd: `cat ${f.path}` }) } });
    rows.push({ timestamp: ts(), type: "response_item", payload: { type: "function_call_output", output: f.text } });
  }
  return rows;
}

const old = new Date("2026-01-15T00:00:00Z");
const count = Math.round(60 * scale);
for (let n = 0; n < count; n++) {
  const claude = n % 2 === 0;
  const dir = claude ? join(out, "claude", "projects", `-work-project-${n % 12}`) : join(out, "codex", "sessions", "2026", "01");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, claude ? `${uuid()}.jsonl` : `rollout-2026-01-01T00-00-00-${uuid()}.jsonl`);
  writeFileSync(path, (claude ? claudeSession(n) : codexSession(n)).map((r) => JSON.stringify(r)).join("\n") + "\n");
  utimesSync(path, old, old);
}
