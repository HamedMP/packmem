// The flights dataset behind the demo API, held either as an array of objects (baseline) or as a packmem Table.
// Kept identical in demos/express/src/store.ts and demos/nextjs/lib/store.ts.
import { readFileSync } from "node:fs";
import { fromPg, loadJsonl, type Filters, type Row, type Table } from "packmem";

export type Mode = "baseline" | "packmem";
/** Where the rows come from: a JSON-lines file, or a Postgres table (`postgres://...` URL). */
export type Source = { kind: "file"; path: string } | { kind: "postgres"; url: string };
const PG_QUERY = "select * from flights";

export interface Query {
  carrier?: string;
  origin?: string;
  dest?: string;
  minDelay?: number;
}

export interface Summary {
  flights: number;
  total_distance: number;
  delayed_over_60: number;
}

export interface Store {
  mode: Mode;
  source: Source["kind"];
  rows: number;
  loadMs: number;
  packedBytes: number | null;
  list(q: Query, limit: number, offset: number): { total: number; rows: Row[] };
  byDest(q: Query): Record<string, number>;
  summary(q: Query): Summary;
  /** The matching rows as one JSON array, in pieces. */
  exportChunks(q: Query): Iterable<string | Uint8Array>;
}

export function parseQuery(get: (k: string) => string | null | undefined): Query {
  const s = (k: string) => get(k) || undefined;
  const d = s("min_delay");
  return { carrier: s("carrier"), origin: s("origin"), dest: s("dest"), minDelay: d === undefined ? undefined : Number(d) };
}

async function withPg<T>(url: string, f: (client: import("pg").Client) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await f(client);
  } finally {
    await client.end();
  }
}

async function baseline(src: Source): Promise<Store> {
  const t0 = performance.now();
  const rows: Row[] =
    src.kind === "file"
      ? readFileSync(src.path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : await withPg(src.url, async (c) => (await c.query(PG_QUERY)).rows);
  const loadMs = performance.now() - t0;
  const match = (q: Query) => (r: Row) =>
    (q.carrier === undefined || r.carrier === q.carrier) &&
    (q.origin === undefined || r.origin === q.origin) &&
    (q.dest === undefined || r.dest === q.dest) &&
    (q.minDelay === undefined || (typeof r.dep_delay === "number" && r.dep_delay > q.minDelay));
  return {
    mode: "baseline",
    source: src.kind,
    rows: rows.length,
    loadMs,
    packedBytes: null,
    list(q, limit, offset) {
      const hit = rows.filter(match(q));
      return { total: hit.length, rows: hit.slice(offset, offset + limit) };
    },
    byDest(q) {
      const m = match(q);
      const out: Record<string, number> = {};
      for (const r of rows) if (m(r) && typeof r.dest === "string") out[r.dest] = (out[r.dest] ?? 0) + 1;
      return out;
    },
    summary(q) {
      const m = match(q);
      let flights = 0, total_distance = 0, delayed_over_60 = 0;
      for (const r of rows) {
        if (!m(r)) continue;
        flights++;
        if (typeof r.distance === "number") total_distance += r.distance;
        if (typeof r.dep_delay === "number" && r.dep_delay > 60) delayed_over_60++;
      }
      return { flights, total_distance, delayed_over_60 };
    },
    *exportChunks(q) {
      yield JSON.stringify(rows.filter(match(q)));
    },
  };
}

async function packed(src: Source): Promise<Store> {
  const t0 = performance.now();
  const t: Table = src.kind === "file" ? loadJsonl(src.path) : await withPg(src.url, (c) => fromPg(c, PG_QUERY));
  const loadMs = performance.now() - t0;
  const filters = (q: Query): Filters => ({
    carrier: q.carrier,
    origin: q.origin,
    dest: q.dest,
    dep_delay: q.minDelay === undefined ? undefined : { gt: q.minDelay },
  });
  return {
    mode: "packmem",
    source: src.kind,
    rows: t.length,
    loadMs,
    packedBytes: t.nbytes,
    list(q, limit, offset) {
      const v = t.where(filters(q));
      return { total: v.length, rows: v.rows({ offset, limit }) };
    },
    byDest(q) {
      return t.groupCount("dest", filters(q));
    },
    summary(q) {
      const v = t.where(filters(q));
      return { flights: v.length, total_distance: v.sum("distance"), delayed_over_60: v.where({ dep_delay: { gt: 60 } }).length };
    },
    exportChunks(q) {
      return t.where(filters(q)).jsonChunks();
    },
  };
}

export async function createStore(mode: Mode, src: Source): Promise<Store> {
  const store = await (mode === "packmem" ? packed(src) : baseline(src));
  // With --expose-gc (the benchmark sets it), collect load garbage so idle memory is the steady state in both modes.
  (globalThis as { gc?: () => void }).gc?.();
  return store;
}

/** FLIGHTS_PG_URL selects Postgres; otherwise FLIGHTS_PATH or the default file. */
export function sourceFromEnv(defaultPath: string): Source {
  const url = process.env.FLIGHTS_PG_URL;
  return url ? { kind: "postgres", url } : { kind: "file", path: process.env.FLIGHTS_PATH ?? defaultPath };
}

export function memory() {
  const m = process.memoryUsage();
  const mb = (b: number) => Math.round((b / 1e6) * 10) / 10;
  return { rss_mb: mb(m.rss), heap_used_mb: mb(m.heapUsed), external_mb: mb(m.external) };
}
