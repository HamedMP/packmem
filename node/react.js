// A React hook over packmem tables: build objects only for the rows a component shows.
//
// It imports nothing from React. Next.js loads packmem outside its bundle (packmem loads a native addon), and there
// `import "react"` would find a second copy of React and every hook call would fail. A small cache gives what useMemo
// would: the same array on every render until the window or the table changes.

const cache = new WeakMap();
const NONE = Object.freeze([]);

/**
 * The rows `offset` to `offset + limit` of a Table or View, as plain objects, rebuilt only when the range changes or
 * the table does (through packmem's own methods). Made for virtualized lists: pass the visible window.
 */
export function useRows(rows, { offset = 0, limit = 50 } = {}) {
  if (!rows) return NONE;
  const version = (rows.table ?? rows)._version;
  const last = cache.get(rows);
  if (last && last.version === version && last.offset === offset && last.limit === limit) return last.rows;
  const end = Math.min(offset + limit, rows.length);
  const out = typeof rows.rows === "function" ? rows.rows({ offset, limit: end - offset }) : rows.slice(offset, end);
  cache.set(rows, { version, offset, limit, rows: out });
  return out;
}
