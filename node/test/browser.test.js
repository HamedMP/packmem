// A server sends tables to a real browser running packmem/wasm: bytes from Node (and Python, when PACKMEM_PYTHON
// is set), JSON from a server without packmem, and the browser reads the same rows from each.
// Needs a Chromium for playwright-core: `npx playwright-core install chromium`, or an installed Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import * as pm from "../index.js";
import { send } from "../http.js";

const root = new URL("../", import.meta.url);
const rows = Array.from({ length: 20_000 }, (_, i) => ({
  id: i,
  user: `u${i % 300}`,
  text: i % 9 ? `message ${i} ${"é".repeat(i % 5)}` : null,
  turns: i % 6 ? [{ role: "user", content: `q${i}` }, { role: "assistant", content: "a".repeat(i % 40) }] : [],
}));

async function launch() {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    return null;
  }
  for (const opts of [{}, { channel: "chrome" }]) {
    try {
      return await chromium.launch(opts);
    } catch {}
  }
  return null;
}

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { init } from "/wasm.js";
import { fetchTable } from "/http.js";
const pm = await init("/wasm-dist/packmem_bg.wasm");
const out = {};
for (const path of ["/api/rows", "/api/plain", ...(await (await fetch("/api/sources")).json())]) {
  const t = await fetchTable(pm, path);
  out[path] = { length: t.length, json: new TextDecoder().decode(t.jsonBuffer()), where: t.where({ user: "u7" }).count() };
}
window.result = out;
</script>`;

test("a browser reads tables sent by Node and Python servers", async (t) => {
  if (!existsSync(new URL("wasm-dist/packmem_bg.wasm", root))) return t.skip("build it first: node scripts/build-wasm.mjs");
  const browser = await launch();
  if (!browser) {
    if (process.env.PACKMEM_REQUIRE_BROWSER) throw new Error("no Chromium, and PACKMEM_REQUIRE_BROWSER is set");
    return t.skip("no Chromium: npx playwright-core install chromium");
  }
  const table = new pm.Table(rows);
  const sources = [];
  let fromPython;
  if (process.env.PACKMEM_PYTHON) {
    const script = "import json, sys, packmem\nsys.stdout.buffer.write(packmem.Table(json.loads(sys.stdin.read())).to_bytes())";
    fromPython = execFileSync(process.env.PACKMEM_PYTHON, ["-c", script], { input: JSON.stringify(rows), maxBuffer: 1 << 28 });
    sources.push("/api/python");
  }
  const types = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    if (path === "/api/rows") return send(req, res, table);
    if (path === "/api/plain") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
    if (path === "/api/sources") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sources));
    if (path === "/api/python") return res.writeHead(200, { "content-type": "application/vnd.packmem" }).end(fromPython);
    const file = new URL(`.${path}`, root);
    const ok = ["/wasm.js", "/api.js", "/http.js", "/wasm-dist/packmem.js", "/wasm-dist/packmem_bg.wasm"].includes(path);
    if (!ok || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.slice(path.lastIndexOf("."))] }).end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.result || null, null, { timeout: 30_000 }).catch(() => {});
    assert.deepEqual(errors, []);
    const result = await page.evaluate(() => window.result);
    const want = { length: rows.length, json: JSON.stringify(rows), where: rows.filter((r) => r.user === "u7").length };
    for (const path of ["/api/rows", "/api/plain", ...sources]) assert.deepEqual(result[path], want, path);
  } finally {
    server.close();
    await browser.close();
  }
});
