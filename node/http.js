// Sending tables over HTTP: packed bytes to clients that ask for them, JSON to every other client.
// No Node APIs, so the same module runs in servers (Node, Bun, Deno, Workers, Next.js route handlers) and browsers.

/** The media type of packmem's byte form. */
export const PACKMEM_TYPE = "application/vnd.packmem";

// Hosts compress only the types they know (Next.js gzips JSON, not packmem bytes, and drops a route's own
// Content-Encoding), so the bytes are gzipped inside the payload and say so in the media type: `enc=gzip`.
const GZIP_TYPE = `${PACKMEM_TYPE}; enc=gzip`;
// Below this, gzip's header and the stream setup cost more than they save.
const GZIP_MIN = 1024;

function acceptOf(accept) {
  if (accept && typeof accept === "object") accept = accept.headers?.get?.("accept") ?? accept.headers?.accept;
  return typeof accept === "string" ? accept : "";
}

/** The Accept entries for `type`, with their parameters. */
function entries(accept, type) {
  const out = [];
  for (const part of accept.split(",")) {
    const [name, ...params] = part.trim().split(";").map((s) => s.trim());
    if (name.toLowerCase() !== type) continue;
    const p = Object.fromEntries(params.map((s) => s.split("=").map((x) => x.trim().toLowerCase())));
    out.push({ q: p.q === undefined ? 1 : Number(p.q) || 0, enc: p.enc });
  }
  return out;
}

/** True when an Accept header (or a Request carrying one) asks for packmem bytes ahead of JSON. */
export function wantsPackmem(accept) {
  accept = acceptOf(accept);
  const pkm = Math.max(-1, ...entries(accept, PACKMEM_TYPE).map((e) => e.q));
  const json = Math.max(-1, ...entries(accept, "application/json").map((e) => e.q));
  return pkm > 0 && pkm >= json;
}

/** True when the client can read gzipped packmem bytes (`Accept: application/vnd.packmem; enc=gzip`). */
const takesGzip = (accept) => entries(acceptOf(accept), PACKMEM_TYPE).some((e) => e.enc === "gzip" && e.q > 0);

const bytesOf = (rows) => (typeof rows.toBytes === "function" ? rows.toBytes() : rows.table.take(rows.ids).toBytes());

/** The bytes to send and their media type: gzipped when the client reads that and it is worth it. */
function payload(request, rows, gzip) {
  const b = bytesOf(rows);
  if (gzip === false || b.byteLength < GZIP_MIN || !takesGzip(request)) return { type: PACKMEM_TYPE, body: b };
  return { type: GZIP_TYPE, body: new Blob([b]).stream().pipeThrough(new CompressionStream("gzip")) };
}

/**
 * A Response holding `rows` (a Table or a View): packmem bytes when the request asks for them, gzipped when it says
 * it reads that, and a streamed JSON array otherwise. `Vary: Accept` keeps caches from handing one form to a client
 * that asked for another. Pass `{ gzip: false }` when something in front of the server compresses the bytes already.
 */
export function respond(request, rows, init = {}, { gzip } = {}) {
  const headers = new Headers(init.headers);
  headers.append("vary", "accept");
  if (wantsPackmem(request)) {
    const { type, body } = payload(request, rows, gzip);
    headers.set("content-type", type);
    return new Response(body, { ...init, headers });
  }
  headers.set("content-type", "application/json");
  return new Response(rows.jsonWebStream(), { ...init, headers });
}

/** As `respond`, for Node's http.ServerResponse (Express, Fastify's raw reply, plain node:http). */
export async function send(req, res, rows, status = 200, { gzip } = {}) {
  res.setHeader("vary", "accept");
  if (wantsPackmem(req)) {
    const { type, body } = payload(req, rows, gzip);
    if (body instanceof Uint8Array) {
      res.writeHead(status, { "content-type": type, "content-length": body.byteLength });
      res.end(body);
      return;
    }
    res.writeHead(status, { "content-type": type });
    for await (const chunk of body) res.write(chunk);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  for (const chunk of rows.jsonChunks()) res.write(chunk);
  res.end();
}

/**
 * Fetch a table: asks for packmem bytes (gzipped or not) and reads them with `pm` (the API from `packmem` or
 * `packmem/wasm`), or parses the JSON a server without packmem sends. Bytes from a newer packmem than `pm` are refused
 * by the reader, so then it asks again for JSON. Works as an SWR or TanStack Query fetcher.
 */
export async function fetchTable(pm, input, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", `${GZIP_TYPE}, ${PACKMEM_TYPE};q=0.95, application/json;q=0.9`);
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
  const [type, ...params] = (res.headers.get("content-type") ?? "").split(";").map((s) => s.trim().toLowerCase());
  const gz = type === PACKMEM_TYPE && params.includes("enc=gzip") && res.body;
  const body = new Uint8Array(await (gz ? new Response(res.body.pipeThrough(new DecompressionStream("gzip"))) : res).arrayBuffer());
  if (type !== PACKMEM_TYPE) return { table: pm.parse(body) };
  try {
    return { table: pm.Table.fromBytes(body) };
  } catch (e) {
    if (/newer packmem/.test(String(e?.message))) return { newer: e };
    throw e;
  }
}
