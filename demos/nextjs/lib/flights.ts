import path from "node:path";
import { createStore, parseQuery, type Mode, type Store } from "./store";

const g = globalThis as { __flights?: Store };

/** One dataset per server process, loaded on first use. MODE=baseline holds it as an array of objects. */
export function flights(): Store {
  return (g.__flights ??= createStore(
    (process.env.MODE ?? "packmem") as Mode,
    process.env.FLIGHTS_PATH ?? path.join(process.cwd(), "../../data/flights.jsonl"),
  ));
}

export function queryOf(req: Request) {
  const p = new URL(req.url).searchParams;
  return parseQuery((k) => p.get(k));
}
