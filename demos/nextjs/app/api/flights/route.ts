import { flights, handle, pageOf, queryOf } from "@/lib/flights";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handle(async () => {
    const { limit, offset } = pageOf(req);
    return Response.json((await flights()).list(queryOf(req), limit, offset));
  });
}
