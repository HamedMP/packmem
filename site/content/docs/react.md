# packmem/react

Hooks for React components that show rows of a packmem `Table` or `View`. A component builds objects only for the
rows it shows, so a list over hundreds of thousands of rows holds a few dozen objects at a time.

```js
import { useRows } from "packmem/react";
```

## useRows

```ts
useRows(rows: Table | View | null | undefined, range?: { offset?: number; limit?: number }): Row[]
```

Returns rows `offset` to `offset + limit` (defaults 0 and 50) as plain objects. It returns the same array on every
render until the range changes or the table changes through packmem's own methods (`push`, `set`, `update`, ...),
so it can feed `React.memo` children and effect dependencies. A window past the end stops at the last row;
`null` gives an empty array.

A virtualized list:

```tsx
"use client"
import { useState } from "react"
import { useRows } from "packmem/react"
import type { Table } from "packmem"

const ROW = 28
const SHOWN = 20

export function Rows({ table }: { table: Table }) {
  const [offset, setOffset] = useState(0)
  const rows = useRows(table, { offset, limit: SHOWN })
  return (
    <div style={{ height: ROW * SHOWN, overflowY: "auto" }} onScroll={(e) => setOffset(Math.floor(e.currentTarget.scrollTop / ROW))}>
      <div style={{ height: table.length * ROW, position: "relative" }}>
        <ul style={{ position: "absolute", top: offset * ROW }}>
          {rows.map((r, i) => (
            <li key={offset + i} style={{ height: ROW }}>{String(r.name)}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
```

It works with any virtualizer (TanStack Virtual, react-window): pass the visible range.

## It does not import React

`useRows` calls no React API: it keeps its last result per table in a small cache. That is deliberate. Next.js
loads packmem outside its bundle (it has to, for the native addon), and there a `react` import would find a second
copy of React and every hook call would fail. So `packmem/react` works in server components, client components and
plain functions alike, and has no peer dependency on React.

## Getting a table into a component

Fetch it with [`fetchTable`](/docs/http/) in an effect, or through SWR or TanStack Query:

```js
const { data: table } = useSWR(url, (u) => fetchTable(pm, u))
const rows = useRows(table, { offset, limit: 20 })
```

The [Next.js guide](/docs/nextjs/) has a full client component.
