import { flights, queryOf } from "@/lib/flights";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return Response.json(flights().byDest(queryOf(req)));
}
