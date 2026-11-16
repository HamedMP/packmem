"""Synthetic agent-log rows with deep, varied nested values, the shape that makes keeping them as JSON text beat
splitting them into sub-columns. Nothing comes from a real transcript.
usage: nested_gen.py <out.jsonl> [rows]
Modelled on measurements of real Codex rollouts: a `payload` record whose `item` is an object nested up to 7
levels with a shape that varies by event type (messages, tool calls with arguments, reasoning summaries, file
changes), `output` that is a string in some rows and a list of parts in others, ids and short enums inside."""
import json, random, sys

rnd = random.Random(7)
out, rows = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 20000
WORDS = ("the a to of and in is it for on with that this as be are was by at or an from not but can if will have has use "
         "file test run build fix error value table column row data type return function const let import export async "
         "await new string number list map set get add remove update check write read open close load save parse query "
         "filter group sum count index key name path line text json node python rust memory packed record field").split()
FILES = [f"src/module_{i}/part_{j}.ts" for i in range(40) for j in range(5)]
words = lambda n: " ".join(rnd.choice(WORDS) for _ in range(n))
hexid = lambda n=16: "".join(rnd.choice("0123456789abcdef") for _ in range(n))
code = lambda: "\n".join(f"  {rnd.choice(['const', 'let', 'return', 'if'])} {words(6)}; // {i}" for i in range(rnd.randint(3, 40)))

def item(kind):
    if kind == "message":
        return {"type": "message", "id": f"msg_{hexid()}", "role": rnd.choice(["assistant", "user"]),
                "content": [{"type": "output_text", "text": words(rnd.randint(10, 120)), "annotations": []} for _ in range(rnd.randint(1, 3))],
                "metadata": {"turn": {"id": hexid(8), "parent": hexid(8), "attempt": rnd.randint(0, 2)}}}
    if kind == "tool_call":
        return {"type": "function_call", "id": f"fc_{hexid()}", "call_id": f"call_{hexid(24)}", "name": rnd.choice(["exec", "apply_patch", "read_file", "search"]),
                "arguments": {"cmd": ["bash", "-lc", f"cat {rnd.choice(FILES)} | head -{rnd.randint(5, 200)}"], "workdir": "/work/project",
                              "options": {"timeout_ms": rnd.choice([10000, 30000, 120000]), "env": {"CI": "1", "LANG": "C.UTF-8"}}}}
    if kind == "patch":
        f = rnd.choice(FILES)
        return {"type": "custom_tool_call", "id": f"ct_{hexid()}", "name": "apply_patch",
                "input": {"changes": [{"path": f, "kind": {"type": "update", "hunks": [{"old_start": rnd.randint(1, 400), "lines": code().split("\n")} for _ in range(rnd.randint(1, 3))]}}]}}
    return {"type": "reasoning", "id": f"rs_{hexid()}", "summary": [{"type": "summary_text", "text": words(rnd.randint(20, 80))}],
            "content": None, "encrypted_content": None, "status": rnd.choice(["completed", "in_progress"])}

with open(out, "w") as fh:
    for n in range(rows):
        kind = rnd.choice(["message", "message", "tool_call", "patch", "reasoning"])
        it = item(kind)
        payload = {"type": "item_completed", "item": it}
        if kind == "tool_call":
            payload["output"] = code() if rnd.random() < 0.3 else [{"type": "input_text", "text": code()} for _ in range(rnd.randint(1, 3))]
        fh.write(json.dumps({"timestamp": f"2026-01-01T00:{n // 3600 % 60:02d}:{n % 60:02d}.000Z", "type": "event_msg", "payload": payload},
                            ensure_ascii=False, separators=(",", ":")) + "\n")
