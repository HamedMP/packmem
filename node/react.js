// React hooks over packmem tables: fetch a table into the browser, and build objects only for the rows on screen.
//
// Next.js loads packmem outside its bundle on the server (packmem loads a native addon), and there "react" is a second
// copy of React whose hooks fail. So useRows calls no React hooks at all, and useTable calls them only in the browser,
// where packmem is bundled with the app's own React. On the server useTable returns the loading state, which is what a
// fetch-in-an-effect hook renders there anyway.
import { useEffect, useState } from "react";
import { fetchTable } from "./http.js";

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

let wasm;
/** packmem/wasm, instantiated once per page. Without `source`, the bundler serves the .wasm file next to its glue. */
function packmem(source) {
  wasm ??= import("./wasm.js").then((m) => m.init(source)).catch((e) => {
    wasm = undefined;
    throw e;
  });
  return wasm;
}

const LOADING = Object.freeze({ table: null, error: null, loading: true, ms: 0 });
const onServer = typeof window === "undefined";

/**
 * Fetch a table from `url` (packmem bytes when the server sends them, JSON otherwise) and open it with packmem/wasm.
 * Refetches when `url` changes, keeping the previous table until the new one is ready; a response for a URL that is
 * no longer current is dropped. `null` fetches nothing.
 */
export function useTable(url, { wasm: source, packmem: api, init } = {}) {
  if (onServer) return LOADING;
  return useTableInBrowser(url, source, api, init);
}

function useTableInBrowser(url, source, api, init) {
  const [state, setState] = useState(LOADING);
  useEffect(() => {
    if (url == null) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return;
    }
    let live = true;
    const t0 = performance.now();
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    Promise.resolve(api ?? packmem(source))
      .then((pm) => fetchTable(pm, url, init))
      .then(
        (table) => live && setState({ table, error: null, loading: false, ms: performance.now() - t0 }),
        (error) => live && setState((s) => ({ ...s, error, loading: false })),
      );
    return () => {
      live = false;
    };
    // `init` and `source` are read when the URL changes; a new object for them on every render must not refetch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, api]);
  return state;
}
