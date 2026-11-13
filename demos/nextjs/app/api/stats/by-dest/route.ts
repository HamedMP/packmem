import { flights, queryOf } from "@/lib/flights";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return Response.json((await flights()).byDest(queryOf(req)));
}
