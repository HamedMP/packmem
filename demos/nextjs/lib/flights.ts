import path from "node:path";
import { BadRequest, createStore, parsePage, parseQuery, sourceFromEnv, type Mode, type Store } from "./store";

const g = globalThis as { __flights?: Promise<Store> };

/** One dataset per server process, loaded on first use. MODE=baseline holds it as an array of objects. */
export function flights(): Promise<Store> {
  if (!g.__flights) {
    g.__flights = createStore(
      (process.env.MODE ?? "packmem") as Mode,
      sourceFromEnv(path.join(process.cwd(), "../../data/flights.jsonl")),
    );
    // a failed load is retried on the next request instead of being cached for the life of the process
    g.__flights.catch(() => (g.__flights = undefined));
  }
  return g.__flights;
}

const params = (req: Request) => {
  const p = new URL(req.url).searchParams;
  return (k: string) => p.get(k);
};
export const queryOf = (req: Request) => parseQuery(params(req));
export const pageOf = (req: Request) => parsePage(params(req));

/** Runs a handler and turns a malformed parameter into a 400, as the Express demo does. */
export async function handle(f: () => Promise<Response>): Promise<Response> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof BadRequest) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
