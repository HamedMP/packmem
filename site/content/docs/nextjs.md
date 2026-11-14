# Next.js

A Next.js app holds a table in its server process, answers queries from it in route handlers, and sends a client
page the packed bytes to open in the browser. This is how `demos/nextjs` and `demos/log-viewer` in the repository
are built, on Next.js 16 with React 19.

```sh
npm install packmem
```

## 1. Keep packmem out of the server bundle

packmem loads a native addon, which a bundler cannot include. List it in `serverExternalPackages`:

```ts
// next.config.ts
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  serverExternalPackages: ["packmem"],
}

export default nextConfig
```

Without it, the build fails with an error about the `.node` file not being placeable in a chunk.

## 2. Load the data once per process

```ts
// lib/flights.ts
import path from "node:path"
import { loadJsonl, type Table } from "packmem"

const g = globalThis as { __flights?: Table }

export function flights(): Table {
  g.__flights ??= loadJsonl(path.join(process.cwd(), "data/flights.jsonl"))
  return g.__flights
}
```

Keeping it on `globalThis` keeps one table across hot reloads in development. Load from Postgres with `fromPg` or
`fromPgCopy` instead (see [Node](/docs/node/#postgres)).

## 3. Route handlers

JSON for small answers, and the whole selection as bytes or JSON through [`respond`](/docs/http/):

```ts
// app/api/flights/route.ts
import { flights } from "@/lib/flights"

export const dynamic = "force-dynamic"

export function GET(request: Request) {
  const carrier = new URL(request.url).searchParams.get("carrier") ?? "UA"
  return Response.json(flights().where({ carrier }).rows({ limit: 50 }))
}
```

```ts
// app/api/flights/export/route.ts
import { respond } from "packmem/http"
import { flights } from "@/lib/flights"

export const dynamic = "force-dynamic"

export function GET(request: Request) {
  const carrier = new URL(request.url).searchParams.get("carrier") ?? "UA"
  return respond(request, flights().where({ carrier }))
}
```

`respond` gzips the bytes inside the payload for clients that ask for it (from 0.3.2), because Next.js compresses
JSON responses but not `application/vnd.packmem`.

## 4. A client component

`useTable` fetches the export and opens it with `packmem/wasm`; `useRows` builds objects for the rows on screen.
Next.js serves the `.wasm` file for you.

```tsx
// app/browse/browser.tsx
"use client"

import { useState } from "react"
import { useRows, useTable } from "packmem/react"

export function Browser({ carrier }: { carrier: string }) {
  const { table, error } = useTable(`/api/flights/export?carrier=${carrier}`)
  const [offset, setOffset] = useState(0)
  const rows = useRows(table, { offset, limit: 20 })

  if (error) return <p>{error.message}</p>
  if (!table) return <p>Loading…</p>
  return (
    <>
      <p>{table.length} flights</p>
      <ul>
        {rows.map((r, i) => (
          <li key={offset + i}>{`${r.carrier} ${r.flight} ${r.origin} → ${r.dest}`}</li>
        ))}
      </ul>
      <button onClick={() => setOffset(Math.min(offset + 20, table.length - 1))}>Next 20</button>
    </>
  )
}
```

Render it from a server component page: `<Browser carrier="UA" />`. See [packmem/react](/docs/react/) for a
virtualized list.

### Without useTable (0.3.0 and 0.3.1)

`useTable` is new in 0.3.2. With an earlier version, or to control loading yourself, serve the `.wasm` file and call
`init` and `fetchTable`. Copy the file into `public/` when installing:

```json
{
  "scripts": {
    "postinstall": "cp node_modules/packmem/wasm-dist/packmem_bg.wasm public/packmem.wasm"
  }
}
```

or serve it from a route handler, as `demos/nextjs` does:

```ts
// app/packmem.wasm/route.ts
import { readFile } from "node:fs/promises"
import path from "node:path"

export async function GET() {
  const wasm = await readFile(path.join(process.cwd(), "node_modules/packmem/wasm-dist/packmem_bg.wasm"))
  return new Response(new Uint8Array(wasm), {
    headers: { "content-type": "application/wasm", "cache-control": "public, max-age=3600" },
  })
}
```

then, in the client component:

```tsx
import { useEffect, useState } from "react"
import { fetchTable } from "packmem/http"
import { init, type PackmemWasm } from "packmem/wasm"
import type { Table } from "packmem"

let pm: Promise<PackmemWasm> | undefined

function useFlights(carrier: string) {
  const [table, setTable] = useState<Table | null>(null)
  useEffect(() => {
    let live = true
    pm ??= init("/packmem.wasm")
    pm.then((api) => fetchTable(api, `/api/flights/export?carrier=${carrier}`)).then((t) => live && setTable(t))
    return () => {
      live = false
    }
  }, [carrier])
  return table
}
```

## Versions

The server and the browser read and write packed bytes with the packmem installed in the app, so one
`package.json` keeps them on the same version. If the browser code is cached or served separately (a CDN, another
app), deploy it no later than the server: a reader refuses bytes from a newer format. From 0.3.1, `fetchTable` (and
so `useTable`) then falls back to JSON instead of failing. See [Byte format](/docs/format/).

## Deploying

The route handlers need the Node.js runtime (the default), not the Edge runtime, because they use the native addon.
On Vercel the Linux x86-64 addon in the npm package is the one that loads; this setup has not been tested on Vercel
yet. Vercel Functions limit a response that is not streamed to 4.5 MB: JSON and gzipped bytes are streamed, plain
bytes are sent as one buffer. Memory is the main gain on the server: the demo's Next.js server holding the flights
data settles at a fraction of the memory of an array of objects (figures in
[demos/README.md](https://github.com/HamedMP/packmem/blob/main/demos/README.md)).
