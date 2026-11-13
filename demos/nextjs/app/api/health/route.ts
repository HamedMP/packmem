import { flights } from "@/lib/flights";
import { memory } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await flights();
  return Response.json({
    framework: "nextjs",
    mode: s.mode,
    source: s.source,
    rows: s.rows,
    load_ms: Math.round(s.loadMs),
    packed_mb: s.packedBytes && Math.round(s.packedBytes / 1e5) / 10,
    ...memory(),
  });
}
