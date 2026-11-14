# packmem/http

`packmem/http` sends tables over HTTP: packed bytes to clients that ask for them, a streamed JSON array to every
other client. It has no Node imports, so the same module runs in Node, Next.js route handlers, Cloudflare Workers
and browsers.

```js
import { respond, send, fetchTable, wantsPackmem, PACKMEM_TYPE } from "packmem/http";
```

## How it negotiates

A client asks for bytes with `Accept: application/vnd.packmem`. The server sends bytes only when that type has
a quality greater than zero and at least as high as `application/json`; otherwise it sends JSON. Every response
carries `Vary: Accept`, so caches keep the two forms apart. Clients that know nothing about packmem (curl, a
browser address bar, another service) get JSON, unchanged.

## Server: web Request and Response

For Next.js route handlers, Cloudflare Workers, Hono, Bun, Deno, anything with `Request` and `Response`:

```js
export function GET(request) {
  return respond(request, flights.where({ carrier: "UA" }));
}
```

`respond(request, rows, init?)` takes a `Table` or a `View`; `init` sets the status and extra headers. A `View`
sends only its rows.

## Server: Node's response object

For Express, plain `node:http`, and Fastify's raw reply:

```js
app.get("/api/flights", (req, res) => send(req, res, flights.where({ carrier: req.query.carrier })));
```

`send(req, res, rows, status = 200)` writes the bytes with a `content-length`, or the JSON array in batches.

## Client

```js
import { init } from "packmem/wasm";          // or: import * as pm from "packmem" in Node
import { fetchTable } from "packmem/http";

const pm = await init("/packmem.wasm");
const table = await fetchTable(pm, "/api/flights?carrier=UA");
```

`fetchTable(pm, input, init?)` sends `Accept: application/vnd.packmem, application/json;q=0.9` unless you set an
`accept` header, then reads bytes with `pm.Table.fromBytes` or JSON with `pm.parse`, by the response's
`content-type`. A response that is not OK throws an `Error` naming the status and URL. Either way you get a
`Table`. From 0.3.1, if the server sends bytes from a newer packmem than `pm` can read, `fetchTable` asks again with
`Accept: application/json` and returns the table from the JSON.

It works as an SWR or TanStack Query fetcher:

```js
const { data: table } = useSWR("/api/flights?carrier=UA", (url) => fetchTable(pm, url));
```

With TanStack Query, set `structuralSharing: false`: a `Table` is not a plain object and must not be deep-compared
or copied.

## Versions

Bytes carry a format version, and a reader refuses bytes from a newer format. The client's packmem must be the
same version as the server's, or newer. Pin the same version on both sides (one `package.json` for a Next.js app
does this), and deploy the client no later than the server when you upgrade. See [Byte format](/docs/format/).

If the client falls behind anyway, `fetchTable` from 0.3.1 on falls back to JSON: the page keeps working, with a
second request and without the gain from bytes. `fetchTable` in 0.3.0 throws the "written by a newer packmem"
error instead.

## When to send bytes

- Bytes pay off for large tables that the client keeps and scrolls, filters or aggregates: the browser opens them
  without parsing and builds objects only for the rows it shows.
- For a few dozen rows, compressed JSON is smaller. Keep those endpoints on JSON (do not send the `Accept` header,
  or return JSON from the server).
- Text-heavy rows (chat messages, documents) compress about as well as JSON, so the gain there is in parsing and
  memory, not in download size.

## Reference

| Export | Signature |
| --- | --- |
| `PACKMEM_TYPE` | `"application/vnd.packmem"` |
| `wantsPackmem` | `(accept: string \| Request \| { headers } \| null \| undefined) => boolean` |
| `respond` | `(request: Request, rows: Table \| View, init?: ResponseInit) => Response` |
| `send` | `(req, res, rows: Table \| View, status?: number) => void` |
| `fetchTable` | `(pm, input: RequestInfo \| URL, init?: RequestInit) => Promise<Table>` |
