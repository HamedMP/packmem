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

```sh
npm install && npm run build && npm start
```

The demo uses `packmem` from npm (0.3.2 or later). To run it against the code in this repository instead, build the
package (it needs Rust and wasm-bindgen; see `../../node/README.md`) and install it with `npm install ../../node`.

Then open http://localhost:3000 in Chrome. The JS heap figure comes from `performance.memory`, which only Chrome
reports.

## What to look at

| Shown on the page | What it measures |
| --- | --- |
| Until usable | from the request to rows on screen: download, then opening the bytes, or `res.json()` |
| JS heap | Chrome's used JS heap. packmem's rows are in WebAssembly memory instead, shown as "Packed table" |
| Over the network | the response body as it arrived, compressed if the server compressed it |

1,000,000 rows on a Linux server, served by `next start` over localhost, with packmem 0.3.2 from npm. Sizes are exact and
the same on every run; the times are three runs in headless Chromium while the machine had a 1-minute load of 3.6 to 4.3,
so they are one-off numbers, not a benchmark. Output: `results/check-0.3.2.txt`.

| | packmem bytes | plain JSON |
| --- | ---: | ---: |
| Over the network | 31.7 MB (31,686,533 B, gzip inside the payload) | 32.7 MB (32,658,189 B, gzip by Next.js) |
| Not compressed | 49.1 MB | 222.1 MB |
| Until usable | 1,327 to 1,471 ms | 3,275 to 3,287 ms |
| Held in the page | a 49.2 MB packed table, in WebAssembly memory | 1,000,000 objects in the JS heap |

An earlier run with the build from this repository, before 0.3.2 and without compression, took 309 ms against 4,335 ms
in headed Chromium, with 3.9 MB against 193.6 MB of JS heap. The heap figures from the headless runs were not consistent
between the page's own reading and a reading after garbage collection, so they are left out here.

Two things to know:

- **Next.js compresses the JSON but not the bytes**, because its compression only applies to content types it knows and
  it removes a `content-encoding` header that a route handler sets. From 0.3.2, `respond` gzips the bytes itself, inside
  the payload, when the client asks for it (`fetchTable` and `useTable` do), so they travel compressed through Next.js too.
  On these rows that makes them about the same size as gzipped JSON; the gain is the time until usable and the memory.
- With a filter, both forms are small and quick: the 40,071 error lines take about 0.1 to 0.2 s either way. The gap
  grows with the number of rows the page holds.

## Deploy to Vercel

The demo depends on the published `packmem`, so Vercel can build it as it is:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FHamedMP%2Fpackmem%2Ftree%2Fmain%2Fdemos%2Flog-viewer&project-name=packmem-log-viewer)

Notes for Vercel:

- The server and the browser get packmem from the same `npm install`, so they read the same byte format. If the
  server ever runs a newer packmem than the page, `fetchTable` falls back to JSON.
- Vercel Functions limit a response to 4.5 MB unless it is streamed. The JSON form is streamed, and so are gzipped
  bytes (what `useTable` asks for). Uncompressed bytes are one buffer, so with the full million rows they may hit that
  limit; filtered views are well under it. This has not been tried on Vercel yet.
- The table is built per function instance, on its first request.
