// Sending tables over HTTP: packed bytes to clients that ask for them, JSON to every other client.
// No Node APIs, so the same module runs in servers (Node, Bun, Deno, Workers, Next.js route handlers) and browsers.

/** The media type of packmem's byte form. */
export const PACKMEM_TYPE = "application/vnd.packmem";

/** True when an Accept header (or a Request carrying one) asks for packmem bytes ahead of JSON. */
export function wantsPackmem(accept) {
  if (accept && typeof accept === "object") accept = accept.headers?.get?.("accept") ?? accept.headers?.accept;
  if (typeof accept !== "string") return false;
  const q = (type) => {
    for (const part of accept.split(",")) {
      const [name, ...params] = part.trim().split(";");
      if (name.trim().toLowerCase() !== type) continue;
      const p = params.map((s) => s.trim()).find((s) => s.startsWith("q="));
      return p ? Number(p.slice(2)) || 0 : 1;
    }
    return -1;
  };
  const pkm = q(PACKMEM_TYPE);
  return pkm > 0 && pkm >= q("application/json");
}

const bytesOf = (rows) => (typeof rows.toBytes === "function" ? rows.toBytes() : rows.table.take(rows.ids).toBytes());

/**
 * A Response holding `rows` (a Table or a View): packmem bytes when the request asks for them, a streamed JSON array
 * otherwise. `Vary: Accept` keeps caches from handing one form to a client that asked for the other.
 */
export function respond(request, rows, init = {}) {
  const headers = new Headers(init.headers);
  headers.append("vary", "accept");
  if (wantsPackmem(request)) {
    headers.set("content-type", PACKMEM_TYPE);
    return new Response(bytesOf(rows), { ...init, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(rows.jsonWebStream(), { ...init, headers });
}

/** As `respond`, for Node's http.ServerResponse (Express, Fastify's raw reply, plain node:http). */
export function send(req, res, rows, status = 200) {
  res.setHeader("vary", "accept");
  if (wantsPackmem(req)) {
    const b = bytesOf(rows);
    res.writeHead(status, { "content-type": PACKMEM_TYPE, "content-length": b.byteLength });
    res.end(b);
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  for (const chunk of rows.jsonChunks()) res.write(chunk);
  res.end();
}

/**
 * Fetch a table: asks for packmem bytes and reads them with `pm` (the API from `packmem` or `packmem/wasm`), or parses
 * the JSON a server without packmem sends. Bytes from a newer packmem than `pm` are refused by the reader, so then it
 * asks again for JSON. Works as an SWR or TanStack Query fetcher.
 */
export async function fetchTable(pm, input, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", `${PACKMEM_TYPE}, application/json;q=0.9`);
  const got = await get(pm, input, { ...init, headers });
  if (!got.newer) return got.table;
  // The server runs a newer packmem whose bytes this build cannot read; its JSON reads anywhere.
  headers.set("accept", "application/json");
  const again = await get(pm, input, { ...init, headers });
  if (again.newer) throw again.newer;
  return again.table;
}

async function get(pm, input, init) {
  const res = await fetch(input, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${res.url || input}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== PACKMEM_TYPE) return { table: pm.parse(body) };
  try {
    return { table: pm.Table.fromBytes(body) };
  } catch (e) {
    if (/newer packmem/.test(String(e?.message))) return { newer: e };
    throw e;
  }
}
