import { PACKMEM_TYPE, wantsPackmem } from "packmem/http";
import { flights, handle, queryOf } from "@/lib/flights";

export const dynamic = "force-dynamic";

/**
 * Every matching row. Packed table bytes for a client that asks for them (`Accept: application/vnd.packmem`), else one
 * JSON array; with packmem that JSON is written from the packed columns and streamed.
 */
export function GET(req: Request) {
  return handle(async () => {
    const store = await flights();
    const bytes = wantsPackmem(req) ? store.exportBytes(queryOf(req)) : null;
    // toBytes returns a fresh ArrayBuffer-backed array; the type says ArrayBufferLike
    if (bytes) return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": PACKMEM_TYPE, vary: "accept" } });
    const chunks = store.exportChunks(queryOf(req))[Symbol.iterator]();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const { value, done } = chunks.next();
        if (done) controller.close();
        else controller.enqueue(typeof value === "string" ? enc.encode(value) : value);
      },
    });
    return new Response(body, { headers: { "content-type": "application/json", vary: "accept" } });
  });
}
