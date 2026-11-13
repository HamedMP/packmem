import { flights, handle, queryOf } from "@/lib/flights";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(async () => Response.json((await flights()).byDest(queryOf(req))));
}
