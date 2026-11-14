import { respond } from "packmem/http";
import { LEVELS, SERVICES, table } from "@/lib/logs";

export const dynamic = "force-dynamic";

/**
 * The logs matching `level` and `service`. A client that asks for packmem bytes (useTable does) gets the packed rows;
 * any other client gets one JSON array, streamed from the packed columns.
 */
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const filters: Record<string, string> = {};
  for (const [key, allowed] of [["level", LEVELS], ["service", SERVICES]] as const) {
    const v = p.get(key);
    if (v && (allowed as readonly string[]).includes(v)) filters[key] = v;
  }
  const t = table().table;
  return respond(req, Object.keys(filters).length ? t.where(filters) : t, { headers: { "cache-control": "no-store" } });
}
