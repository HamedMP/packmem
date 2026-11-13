import { flights } from "@/lib/flights";
import { memory } from "@/lib/store";

export const dynamic = "force-dynamic";

export function GET() {
  const s = flights();
  return Response.json({
    framework: "nextjs",
    mode: s.mode,
    rows: s.rows,
    load_ms: Math.round(s.loadMs),
    packed_mb: s.packedBytes && Math.round(s.packedBytes / 1e5) / 10,
    ...memory(),
  });
}
