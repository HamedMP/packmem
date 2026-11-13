import { flights, handle, queryOf } from "@/lib/flights";

export const dynamic = "force-dynamic";

/** Every matching row as one JSON array. With packmem the bytes are written from the packed columns and streamed. */
export function GET(req: Request) {
  return handle(async () => {
    const chunks = (await flights()).exportChunks(queryOf(req))[Symbol.iterator]();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const { value, done } = chunks.next();
        if (done) controller.close();
        else controller.enqueue(typeof value === "string" ? enc.encode(value) : value);
      },
    });
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
}
