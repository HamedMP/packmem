import { flights, queryOf } from "@/lib/flights";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const limit = Math.min(Number(p.get("limit") ?? 50), 1000);
  const offset = Number(p.get("offset") ?? 0);
  return Response.json((await flights()).list(queryOf(req), limit, offset));
}
