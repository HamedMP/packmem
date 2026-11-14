# Log viewer: a million log lines in the browser

A Next.js app that sends 1,000,000 structured log records to the browser and scrolls through them, built with
`packmem/http` on the server and `useTable` and `useRows` from `packmem/react` in the page. A switch loads the same
rows the usual way, as JSON with `res.json()`, so the two can be compared on the same page.

- `lib/logs.ts` makes the records: a seeded generator, so every run has the same rows. Nothing is downloaded or
  committed. The server builds the table once, on the first request (a few seconds), and keeps it in memory.
  `ROWS=200000 npm start` sets a different size.
- `app/api/logs/route.ts` answers `/api/logs?level=error&service=api` with `respond`: packmem bytes for a client that
  asks for them, a JSON array streamed from the packed columns for anyone else.
- `app/viewer.tsx` is the page. In packmem mode, `useTable(url)` fetches and opens the bytes with `packmem/wasm`, and
  `useRows` builds objects for the 24 rows on screen. In JSON mode, the page fetches the same URL as JSON and keeps the
  array of objects.

## Run it

Build the packmem package in this repository first (it needs Rust and wasm-bindgen; see `../../node/README.md`):

```sh
cd ../../node && npm ci && npm run build && npm run build:wasm
cd ../demos/log-viewer && npm install && npm run build && npm start
```

Then open http://localhost:3000 in Chrome. The JS heap figure comes from `performance.memory`, which only Chrome
reports.

## What to look at

| Shown on the page | What it measures |
| --- | --- |
| Until usable | from the request to rows on screen: download, then opening the bytes, or `res.json()` |
| JS heap | Chrome's used JS heap. packmem's rows are in WebAssembly memory instead, shown as "Packed table" |
| Over the network | the response body as it arrived, compressed if the server compressed it |

One run on a Linux server, Chromium over localhost, 1,000,000 rows (one-off numbers, not a benchmark; they change with
the machine and the network):

| | packmem bytes | plain JSON |
| --- | ---: | ---: |
| Until usable | 309 ms | 4,335 ms |
| JS heap after loading | 3.9 MB, plus a 49.2 MB packed table | 193.6 MB |
| Over the network | 49.1 MB (not compressed) | 32.7 MB (gzip) |

Two things to know:

- **Next.js compresses the JSON but not the bytes.** Its compression only applies to content types it knows, and it
  removes a `content-encoding` header that a route handler sets, so a route cannot gzip the bytes itself. Gzipped,
  these bytes would be 28 MB against 33 MB of gzipped JSON. Behind a CDN or proxy that compresses
  `application/vnd.packmem`, the bytes travel compressed.
- With a filter, both forms are small and quick: the 40,071 error lines take about 0.1 to 0.2 s either way. The gap
  grows with the number of rows the page holds.

## Deploy to Vercel

The `packmem` dependency here is `file:../../node`, the package built from this repository, so the demo runs against
the code next to it. Vercel cannot build that (the native addon and the WebAssembly build need Rust), so to deploy,
change it to the published package once a release with `useTable` is on npm (after 0.3.1):

```sh
npm install packmem@latest
```

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FHamedMP%2Fpackmem%2Ftree%2Fmain%2Fdemos%2Flog-viewer&project-name=packmem-log-viewer)

Notes for Vercel:

- The server and the browser get packmem from the same `npm install`, so they read the same byte format. If the
  server ever runs a newer packmem than the page, `fetchTable` falls back to JSON.
- Vercel Functions limit a response to 4.5 MB unless it is streamed. The JSON form is streamed. The bytes form is
  one buffer, so with the full million rows it may hit that limit; filtered views are well under it. This has not
  been tried on Vercel yet.
- The table is built per function instance, on its first request.
