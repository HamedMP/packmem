// useTable in a real browser: a React page bundled with esbuild fetches tables from a Node server with packmem/wasm.
// Needs the dev dependencies (npm ci) and a Chromium for playwright-core: `npx playwright-core install chromium`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import * as pm from "../index.js";
import { send } from "../http.js";

const root = new URL("../", import.meta.url);

const APP = `
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { useRows, useTable } from "./react.js";
function App() {
  const [url, setUrl] = useState(null);
  window.setUrl = setUrl;
  const s = useTable(url, { wasm: "/wasm-dist/packmem_bg.wasm" });
  const rows = useRows(s.table, { limit: 2 });
  window.states.push({ url, length: s.table?.length ?? null, loading: s.loading, error: s.error && String(s.error), rows });
  return h("p", null, s.loading ? "loading" : String(s.table?.length));
}
window.states = [];
createRoot(document.getElementById("root")).render(h(App));
`;

async function deps() {
  try {
    const [{ chromium }, esbuild] = await Promise.all([import("playwright-core"), import("esbuild"), import("react")]);
    return { chromium, esbuild };
  } catch {
    return null;
  }
}

test("useTable fetches in the browser, follows the URL and drops stale responses", async (t) => {
  if (!existsSync(new URL("wasm-dist/packmem_bg.wasm", root))) return t.skip("build it first: node scripts/build-wasm.mjs");
  const d = await deps();
  let browser;
  for (const opts of d ? [{}, { channel: "chrome" }] : []) {
    try {
      browser = await d.chromium.launch(opts);
      break;
    } catch {}
  }
  if (!browser) {
    if (process.env.PACKMEM_REQUIRE_BROWSER) throw new Error("no Chromium or dev dependencies, and PACKMEM_REQUIRE_BROWSER is set");
    return t.skip("needs npm ci and npx playwright-core install chromium");
  }
  const bundle = await d.esbuild.build({
    stdin: { contents: APP, resolveDir: new URL(".", root).pathname, loader: "js" },
    bundle: true,
    format: "esm",
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const slow = new pm.Table(Array.from({ length: 300 }, (_, i) => ({ id: i, from: "slow" })));
  const fast = new pm.Table(Array.from({ length: 200 }, (_, i) => ({ id: i, from: "fast" })));
  const plain = Array.from({ length: 100 }, (_, i) => ({ id: i, from: "json" }));
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end('<div id="root"></div><script type="module" src="/app.js"></script>');
    if (path === "/app.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles[0].contents);
    if (path === "/wasm-dist/packmem_bg.wasm") return res.writeHead(200, { "content-type": "application/wasm" }).end(readFileSync(new URL(`.${path}`, root)));
    if (path === "/api/slow") return setTimeout(() => send(req, res, slow), 800);
    if (path === "/api/fast") return send(req, res, fast);
    if (path === "/api/plain") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(plain));
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const last = () => page.evaluate(() => window.states.at(-1));
    const until = (f) => page.waitForFunction(f, null, { timeout: 15_000 });

    await until(() => window.states.length > 0);
    assert.equal((await last()).loading, false, "a null URL fetches nothing");

    await page.evaluate(() => window.setUrl("/api/slow"));
    await page.evaluate(() => window.setUrl("/api/fast"));
    await until(() => window.states.at(-1).length === 200);
    await new Promise((r) => setTimeout(r, 1200)); // the slow response arrives after the fast one
    let s = await last();
    assert.deepEqual([s.length, s.loading, s.rows[0]], [200, false, { id: 0, from: "fast" }], "the stale response is dropped");

    await page.evaluate(() => window.setUrl("/api/plain"));
    await until(() => window.states.at(-1).length === 100);
    assert.deepEqual((await last()).rows, [{ id: 0, from: "json" }, { id: 1, from: "json" }], "JSON from a server without packmem");

    await page.evaluate(() => window.setUrl("/api/missing"));
    await until(() => window.states.at(-1).error !== null);
    s = await last();
    assert.match(s.error, /404/);
    assert.equal(s.length, 100, "a failed fetch keeps the previous table");
    assert.deepEqual(errors, []);
  } finally {
    server.close();
    await browser.close();
  }
});
