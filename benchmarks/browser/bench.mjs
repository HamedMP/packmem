// Browser benchmark: the same records sent as a JSON array or as packmem bytes, opened in headless Chromium.
//
//   node bench.mjs <data dir> <out.jsonl> [runs=7] [datasets=flights,chat,issues,traces,logs] [sizes=10,100,1000,10000,100000]
//
// For each dataset and size this serves four payloads from a local server: JSON and packmem bytes (Table#toBytes from
// the Node addon), each as is and Brotli-compressed (quality 5, a typical setting for responses compressed on the fly,
// sent with content-encoding: br so the browser decodes it). Each run opens a fresh browser context and page, so
// nothing is cached and the WebAssembly module is instantiated again; its start-up is timed separately. Brotli
// payloads are also run with the network throttled to 20 Mbit/s and 20 ms latency. Runs alternate JSON and packmem.
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pmDir = dirname(require.resolve("packmem/package.json"));
const pmVersion = require("packmem/package.json").version;
const { parse } = await import("packmem");

const [dataDir, outFile, runsArg, dsArg, sizesArg, configsArg] = process.argv.slice(2);
const RUNS = Number(runsArg ?? 7);
const DATASETS = (dsArg ?? "flights,chat,issues,traces,logs").split(",");
const SIZES = (sizesArg ?? "10,100,1000,10000,100000").split(",").map(Number);
// one equality or substring filter per dataset, run as Array.filter on the objects and as count() on the table
const FILTERS = {
  flights: ["carrier", "eq", "UA"],
  chat: ["image", "contains", "coco"],
  issues: ["state", "eq", "open"],
  traces: ["status", "eq", "ERROR"],
  logs: ["level", "eq", "ERROR"],
};
const NETWORKS = {
  local: null,
  "20mbit": { offline: false, latency: 20, downloadThroughput: (20e6 / 8) | 0, uploadThroughput: (20e6 / 8) | 0 },
};

// Transfer forms. identity and br: the 0.3.0 rows. gzip: packmem/http on main 90602dc, which gzips the bytes inside
// the payload (CompressionStream at the default level, not below 1,024 bytes) and labels them
// application/vnd.packmem; enc=gzip, because hosts such as Next.js compress only types they know; the page unzips
// them with DecompressionStream, as fetchTable does. JSON in that form gets content-encoding: gzip, as Next.js sends it.
const CONFIGS = (configsArg ?? "identity:local,br:local,br:20mbit").split(",").map((c) => c.split(":"));
const GZIP_FORM = "main 90602dc packmem/http gzip";
const br = (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: b.length } });
const load = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");

let payloads = new Map(); // path -> { body, type, encoding }
const statics = {
  "/": [join(here, "page.html"), "text/html"],
  "/page.js": [join(here, "page.js"), "text/javascript"],
  "/pm/wasm.js": [join(pmDir, "wasm.js"), "text/javascript"],
  "/pm/api.js": [join(pmDir, "api.js"), "text/javascript"],
  "/pm/wasm-dist/packmem.js": [join(pmDir, "wasm-dist/packmem.js"), "text/javascript"],
  "/pm/wasm-dist/packmem_bg.wasm": [join(pmDir, "wasm-dist/packmem_bg.wasm"), "application/wasm"],
};
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  // cross-origin isolation gives performance.now() 5 µs resolution instead of 100 µs
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-embedder-policy", "require-corp");
  res.setHeader("cache-control", "no-store");
  const p = payloads.get(path);
  if (p) {
    res.writeHead(200, { "content-type": p.type, ...(p.encoding ? { "content-encoding": p.encoding } : {}), "content-length": p.body.length });
    return res.end(p.body);
  }
  const s = statics[path];
  if (!s) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": s[1] }).end(readFileSync(s[0]));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const chromeVersion = browser.version();

async function runOnce(args, network) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await context.newCDPSession(page);
  await page.exposeFunction("heapUsage", async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return cdp.send("Runtime.getHeapUsage");
  });
  if (network) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", network);
  }
  await page.goto(origin + "/");
  await page.waitForFunction(() => window.ready === true);
  const r = await page.evaluate((a) => window.run(a), args);
  await context.close();
  if (errors.length) throw new Error(errors.join("; "));
  return r;
}

for (const ds of DATASETS) {
  const lines = readFileSync(join(dataDir, `${ds}.jsonl`), "utf8").split("\n").filter(Boolean);
  // a dataset smaller than the largest size also runs at its full length (issues: 3,000)
  const sizes = SIZES.filter((n) => n <= lines.length);
  if (lines.length < Math.max(...SIZES) && !sizes.includes(lines.length)) sizes.push(lines.length);
  for (const n of sizes) {
    const json = Buffer.from(`[${lines.slice(0, n).join(",")}]`);
    const pkm = Buffer.from(parse(lines.slice(0, n).join("\n")).toBytes());
    payloads = new Map([
      ["/d/json", { body: json, type: "application/json" }],
      ["/d/json.br", { body: br(json), type: "application/json", encoding: "br" }],
      ["/d/pkm", { body: pkm, type: "application/vnd.packmem" }],
      ["/d/pkm.br", { body: br(pkm), type: "application/vnd.packmem", encoding: "br" }],
      ["/d/json.gz", { body: gzipSync(json), type: "application/json", encoding: "gzip" }],
      pkm.length < 1024
        ? ["/d/pkm.gz", { body: pkm, type: "application/vnd.packmem" }]
        : ["/d/pkm.gz", { body: gzipSync(pkm), type: "application/vnd.packmem; enc=gzip" }],
    ]);
    const payloadBytes = Object.fromEntries([...payloads].map(([k, v]) => [k, v.body.length]));
    for (const [encoding, network] of CONFIGS) {
      const loadBefore = load();
      for (let i = 0; i < RUNS; i++) {
        const order = i % 2 ? ["packmem", "json"] : ["json", "packmem"];
        for (const format of order) {
          const url = `/d/${format === "json" ? "json" : "pkm"}${{ identity: "", br: ".br", gzip: ".gz" }[encoding]}`;
          const r = await runOnce({ url, format, filter: FILTERS[ds] }, NETWORKS[network]);
          const line = { dataset: ds, rows: n, encoding, network, run: i, ...r, payload_bytes: payloadBytes[url], ...(encoding === "gzip" ? { form: GZIP_FORM } : {}), load_before: loadBefore, packmem: pmVersion, chrome: chromeVersion };
          appendFileSync(outFile, JSON.stringify(line) + "\n");
        }
      }
      console.log(`${ds} ${n} ${encoding} ${network} done (load ${loadBefore} -> ${load()})`);
    }
  }
}
await browser.close();
server.close();
