import { Table } from "packmem";

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export const SERVICES = ["api", "auth", "billing", "search", "checkout", "cart", "email", "worker", "gateway", "media"] as const;
const ROUTES = ["/v1/orders", "/v1/users/:id", "/v1/search", "/v1/cart", "/v1/login", "/v1/invoices", "/v1/upload", "/health"];
const MESSAGES = [
  "request completed",
  "cache miss for key %s",
  "retrying upstream call to %s",
  "slow query on table %s",
  "user %s signed in",
  "payment declined for order %s",
  "queue depth above threshold on %s",
  "connection reset by peer %s",
];

// A small seeded generator, so every server process builds the same rows.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Log = {
  ts: string;
  level: (typeof LEVELS)[number];
  service: (typeof SERVICES)[number];
  host: string;
  route: string;
  status: number;
  duration_ms: number;
  trace_id: string;
  user_id: number | null;
  message: string;
};

/** `n` synthetic structured log records, one second apart on average. */
export function* logs(n: number): Generator<Log> {
  const r = rng(42);
  const start = Date.UTC(2026, 10, 1);
  let t = start;
  for (let i = 0; i < n; i++) {
    t += Math.floor(r() * 2000);
    const x = r();
    const level = x < 0.15 ? "debug" : x < 0.85 ? "info" : x < 0.96 ? "warn" : "error";
    const service = SERVICES[Math.floor(r() * r() * SERVICES.length)];
    const status = level === "error" ? (r() < 0.7 ? 500 : 503) : level === "warn" ? (r() < 0.5 ? 429 : 404) : 200;
    const arg = (Math.floor(r() * 1e6)).toString(36);
    yield {
      ts: new Date(t).toISOString(),
      level,
      service,
      host: `${service}-${Math.floor(r() * 8)}`,
      route: ROUTES[Math.floor(r() * ROUTES.length)],
      status,
      duration_ms: Math.round(r() * r() * 30000) / 10,
      trace_id: Math.floor(r() * 2 ** 52).toString(16).padStart(13, "0") + Math.floor(r() * 4096).toString(16).padStart(3, "0"),
      user_id: r() < 0.3 ? null : Math.floor(r() * 50000),
      message: MESSAGES[Math.floor(r() * MESSAGES.length)].replace("%s", arg),
    };
  }
}

const g = globalThis as { __logs?: { table: Table<Log>; ms: number } };

/** The log table, built once per server process. ROWS sets the size (default 1,000,000). */
export function table() {
  if (!g.__logs) {
    const t0 = performance.now();
    const t = new Table<Log>();
    t.extend(logs(Number(process.env.ROWS ?? 1_000_000)));
    t.compact();
    g.__logs = { table: t, ms: performance.now() - t0 };
  }
  return g.__logs;
}
