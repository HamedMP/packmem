# packmem/react

Two hooks for React components that show a packmem table: `useTable` fetches it into the browser, and `useRows`
builds objects only for the rows on screen, so a list over a million rows holds a few dozen objects at a time.

```js
import { useTable, useRows } from "packmem/react";
```

`useTable` is new in 0.3.2; `useRows` has been there since 0.3.0. React 18 or later is an optional peer dependency.

## useTable

```ts
useTable(url: string | URL | null | undefined, options?: {
  wasm?: WebAssembly.Module | BufferSource | Response | URL | string
  packmem?: { Table; parse }
  init?: RequestInit
}): { table: Table | null; error: Error | null; loading: boolean; ms: number }
```

Fetches `url` with [`fetchTable`](/docs/http/) (packmem bytes when the server sends them, JSON otherwise) and opens it
with `packmem/wasm`, which it instantiates once per page.

- When `url` changes it fetches again, keeping the previous table until the new one is ready, and drops a response
  for a URL that is no longer current. `null` fetches nothing.
- `ms` is the time from the request to the table being ready, for the latest table.
- The `.wasm` file is found through `new URL(file, import.meta.url)`, which Next.js, Vite and webpack serve without
  setup. Elsewhere, pass its URL: `useTable(url, { wasm: "/packmem.wasm" })`.
- `packmem` passes an API you already have instead (from `init` in `packmem/wasm`); `init` is passed to `fetch`
  (headers, credentials).
- On the server it returns the loading state without fetching, which is what a fetch-in-an-effect hook renders
  there anyway.

## useRows

```ts
useRows(rows: Table | View | null | undefined, range?: { offset?: number; limit?: number }): Row[]
```

Returns rows `offset` to `offset + limit` (defaults 0 and 50) as plain objects. It returns the same array on every
render until the range changes or the table changes through packmem's own methods (`push`, `set`, `update`, ...),
so it can feed `React.memo` children and effect dependencies. A window past the end stops at the last row; `null`
gives an empty array.

## Together

```tsx
"use client"
import { useState } from "react"
import { useRows, useTable } from "packmem/react"

const ROW = 28
const SHOWN = 20

export function Logs({ level }: { level: string }) {
  const { table, error, loading, ms } = useTable(`/api/logs?level=${level}`)
  const [offset, setOffset] = useState(0)
  const rows = useRows(table, { offset, limit: SHOWN })

  if (error) return <p>{error.message}</p>
  if (!table) return <p>Loading…</p>
  return (
    <>
      <p>{table.length} lines, ready in {Math.round(ms)} ms{loading && " (updating)"}</p>
      <div style={{ height: ROW * SHOWN, overflowY: "auto" }} onScroll={(e) => setOffset(Math.floor(e.currentTarget.scrollTop / ROW))}>
        <div style={{ height: table.length * ROW, position: "relative" }}>
          <ul style={{ position: "absolute", top: offset * ROW }}>
            {rows.map((r, i) => (
              <li key={offset + i} style={{ height: ROW }}>{String(r.message)}</li>
            ))}
          </ul>
        </div>
      </div>
    </>
  )
}
```

Pair `useRows` with any virtualizer (TanStack Virtual, react-window) by passing it the visible range.

## Why they work inside Next.js

Next.js loads packmem outside its server bundle, because of the native addon. There, `import "react"` finds a
second copy of React, and hooks called from it fail. So `useRows` calls no React hooks at all (it keeps its last
result per table in a small cache), and `useTable` calls them only in the browser, where packmem is bundled with the
app's own React.

The [Next.js guide](/docs/nextjs/) puts the server and this page together, and
[demos/log-viewer](/docs/examples/#log-viewer) is a full app built on both hooks.
