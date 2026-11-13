import path from "node:path";
import { createStore, parseQuery, sourceFromEnv, type Mode, type Store } from "./store";

const g = globalThis as { __flights?: Promise<Store> };

/** One dataset per server process, loaded on first use. MODE=baseline holds it as an array of objects. */
export function flights(): Promise<Store> {
  return (g.__flights ??= createStore(
    (process.env.MODE ?? "packmem") as Mode,
    sourceFromEnv(path.join(process.cwd(), "../../data/flights.jsonl")),
  ));
}

export function queryOf(req: Request) {
  const p = new URL(req.url).searchParams;
  return parseQuery((k) => p.get(k));
}
