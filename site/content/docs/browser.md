# Browsers and edge

`packmem/wasm` is packmem compiled to WebAssembly from the same Rust source as the native addon. It has the same
`Table` and `View` API, without file paths and Node streams, for runtimes that cannot load a native addon.

| Where | How it is tested |
| --- | --- |
| Browsers | Headless Chromium in CI reads tables from Node and Python servers (`node/test/browser.test.js`) |
| Cloudflare Workers | The `demos/workers` app under `wrangler dev` |
| Deno and Bun | Each release runs the package's smoke test, native and WebAssembly, under both |
| Vercel Edge and other runtimes | Not tested yet. They load WebAssembly the same way; report what you find |

## Instantiate

```js
import { init, initSync } from "packmem/wasm";

const pm = await init("/packmem.wasm");                  // a URL, a Response, bytes or a WebAssembly.Module
const pm2 = initSync(compiledModule);                     // synchronous, from a WebAssembly.Module or bytes
```

`init` and `initSync` return the API: `pm.Table`, `pm.View`, `pm.parse`, `pm.parseCsv`, `pm.from`, and the
Postgres helpers. Instantiate once and reuse it; later calls return the same API.

The binary is in the package at `packmem/wasm/packmem.wasm` (the file `wasm-dist/packmem_bg.wasm`). In a browser
app, serve that file and pass its URL to `init`. See the [Next.js guide](/docs/nextjs/) for one way to do it.

## Cloudflare Workers

Workers import `.wasm` files as compiled modules:

```js
import wasm from "packmem/wasm/packmem.wasm";
import { initSync } from "packmem/wasm";

const pm = initSync(wasm);
const DATA_URL = "https://example.com/events.jsonl"; // JSON lines or a JSON array

export default {
  async fetch(request) {
    const events = pm.parse(await (await fetch(DATA_URL)).arrayBuffer());
    return new Response(events.where({ status: 404 }).jsonWebStream(), {
      headers: { "content-type": "application/json" },
    });
  },
};
```

A Worker has 128 MB of memory. `demos/workers` holds a synthetic web log built in batches; its README has the
measurements.

## Open a table sent by a server

```js
const pm = await init("/packmem.wasm");
const rows = pm.Table.fromBytes(new Uint8Array(await (await fetch("/api/rows.pkm")).arrayBuffer()));
rows.length;
rows.slice(0, 50);    // objects only for the rows on screen
```

`fetchTable` from [packmem/http](/docs/http/) does the asking and falls back to JSON. The browser's packmem must be
the same version as the server's, or newer: see [Byte format](/docs/format/).

## Limits

- No `share()`: WebAssembly runs on one thread.
- Tables written with Python's `hint="compact"` cannot be read (the WebAssembly build has no Zstandard).
- WebAssembly memory grows and never shrinks while the module is alive.
