import express, { type Request } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createStore, memory, parseQuery, sourceFromEnv, type Mode } from "./store.ts";

const mode = (process.env.MODE ?? "packmem") as Mode;
const source = sourceFromEnv(fileURLToPath(new URL("../../../data/flights.jsonl", import.meta.url)));
const port = Number(process.env.PORT ?? 3001);

const store = await createStore(mode, source);
const app = express();
const query = (req: Request) => parseQuery((k) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined));

app.get("/api/health", (_req, res) => {
  res.json({ framework: "express", mode: store.mode, source: store.source, rows: store.rows, load_ms: Math.round(store.loadMs), packed_mb: store.packedBytes && Math.round(store.packedBytes / 1e5) / 10, ...memory() });
});

app.get("/api/flights", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 1000);
  const offset = Number(req.query.offset ?? 0);
  res.json(store.list(query(req), limit, offset));
});

app.get("/api/stats/by-dest", (req, res) => {
  res.json(store.byDest(query(req)));
});

app.get("/api/stats/summary", (req, res) => {
  res.json(store.summary(query(req)));
});

// The whole result set as one JSON array. Baseline: res.json on an array of objects.
// packmem: bytes are written from the packed columns in batches and streamed, so no objects or full-size string exist.
app.get("/api/flights/export", async (req, res) => {
  res.type("application/json");
  await pipeline(Readable.from(store.exportChunks(query(req))), res);
});

app.listen(port, () => {
  console.log(JSON.stringify({ listening: port, mode: store.mode, rows: store.rows, load_ms: Math.round(store.loadMs), ...memory() }));
});
