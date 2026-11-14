"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRows, useTable } from "packmem/react";
import type { Log } from "@/lib/logs";

const LEVELS = ["debug", "info", "warn", "error"];
const SERVICES = ["api", "auth", "billing", "search", "checkout", "cart", "email", "worker", "gateway", "media"];
const ROW = 28;
const SHOWN = 24;
const nf = new Intl.NumberFormat("en-US");
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

type Mode = "packmem" | "json";

export function Viewer() {
  const [mode, setMode] = useState<Mode>("packmem");
  const [level, setLevel] = useState("");
  const [service, setService] = useState("");
  const q = new URLSearchParams(Object.entries({ level, service }).filter(([, v]) => v));
  // the same route either way; `as` only keeps the two modes apart in the browser's resource timings
  const url = `/api/logs?${q}${q.size ? "&" : ""}as=${mode}`;
  return (
    <>
      <nav className="filters" aria-label="Filters">
        <Choice label="Load as" value={mode} options={["packmem", "json"]} names={{ packmem: "packmem bytes", json: "plain JSON" }} set={(v) => setMode(v as Mode)} />
        <Choice label="Level" value={level} options={["", ...LEVELS]} set={setLevel} />
        <Choice label="Service" value={service} options={["", ...SERVICES]} set={setService} />
      </nav>
      {/* one mode mounted at a time, so the other's rows can be collected before memory is read */}
      {mode === "packmem" ? <PackmemList key="p" url={url} /> : <JsonList key="j" url={url} />}
    </>
  );
}

function PackmemList({ url }: { url: string }) {
  const { table, error, loading, ms } = useTable<Log>(url);
  const [offset, setOffset] = useState(0);
  const rows = useRows(table, { offset, limit: SHOWN });
  return (
    <Results url={url} count={table?.length} ms={ms} loading={loading} error={error} heldBytes={table?.nbytes} heldLabel="Packed table" rows={rows} offset={offset} setOffset={setOffset} />
  );
}

/** What an app without packmem does: fetch, `res.json()`, keep the array of objects. */
function JsonList({ url }: { url: string }) {
  const [state, setState] = useState<{ rows: Log[] | null; ms: number; loading: boolean; error: Error | null }>({ rows: null, ms: 0, loading: true, error: null });
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let live = true;
    const t0 = performance.now();
    setState((s) => ({ ...s, loading: true }));
    fetch(url, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} from ${url}`))))
      .then(
        (rows: Log[]) => live && setState({ rows, ms: performance.now() - t0, loading: false, error: null }),
        (error: Error) => live && setState((s) => ({ ...s, loading: false, error })),
      );
    return () => {
      live = false;
    };
  }, [url]);
  const rows = state.rows?.slice(offset, offset + SHOWN) ?? [];
  return (
    <Results url={url} count={state.rows?.length} ms={state.ms} loading={state.loading} error={state.error} rows={rows} offset={offset} setOffset={setOffset} />
  );
}

function Results(p: {
  url: string;
  count?: number;
  ms: number;
  loading: boolean;
  error: Error | null;
  heldBytes?: number;
  heldLabel?: string;
  rows: Log[];
  offset: number;
  setOffset: (n: number) => void;
}) {
  const transfer = useTransfer(p.url, p.count);
  const heap = useHeap();
  const list = useRef<HTMLDivElement>(null);
  const { count, setOffset } = p;
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    setOffset(0);
  }, [count, setOffset]);
  return (
    <>
      {p.error && <p className="card error">{String(p.error)}</p>}
      <section className="stats" aria-label="Measurements" data-loading={p.loading || undefined}>
        <Stat label="Rows" value={p.count === undefined ? "…" : nf.format(p.count)} />
        <Stat label="Over the network" value={transfer ? mb(transfer) : "…"} />
        <Stat label="Until usable" value={p.count === undefined ? "…" : `${nf.format(Math.round(p.ms))} ms`} accent />
        <Stat label="JS heap" value={heap === null ? "n/a" : mb(heap)} />
        {p.heldLabel && <Stat label={p.heldLabel} value={p.heldBytes === undefined ? "…" : mb(p.heldBytes)} />}
      </section>
      <section className="card">
        <div ref={list} className="list" style={{ height: ROW * SHOWN }} onScroll={(e) => p.setOffset(Math.floor(e.currentTarget.scrollTop / ROW))}>
          <div style={{ height: (p.count ?? 0) * ROW, position: "relative" }}>
            <table style={{ position: "absolute", top: p.offset * ROW }}>
              <tbody>
                {p.rows.map((r, i) => (
                  <tr key={p.offset + i} style={{ height: ROW }}>
                    <td className="num">{nf.format(p.offset + i + 1)}</td>
                    <td className="mono">{r.ts.slice(5, 19).replace("T", " ")}</td>
                    <td><span className={`level ${r.level}`}>{r.level}</span></td>
                    <td>{r.service}</td>
                    <td className="num">{r.status}</td>
                    <td className="num">{r.duration_ms} ms</td>
                    <td className="mono">{r.route}</td>
                    <td className="msg">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

/** Bytes of the response body as sent (compressed when the server compressed it), from the browser's resource timing. */
function useTransfer(url: string, ready: number | undefined) {
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    if (ready === undefined) return setBytes(null);
    const e = performance.getEntriesByName(new URL(url, location.href).href).at(-1) as PerformanceResourceTiming | undefined;
    setBytes(e ? e.encodedBodySize || e.transferSize : null);
  }, [url, ready]);
  return bytes;
}

/** Chrome's used JS heap, refreshed every second; null in browsers that do not report it. */
function useHeap() {
  const [heap, setHeap] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setHeap((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null);
    read();
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, []);
  return heap;
}

function Choice({ label, value, options, names = {}, set }: { label: string; value: string; options: string[]; names?: Record<string, string>; set: (v: string) => void }) {
  return (
    <div>
      <span>{label}</span>
      {options.map((o) => (
        <button key={o || "all"} className={value === o ? "on" : ""} onClick={() => set(o)}>
          {names[o] ?? (o || "all")}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className={accent ? "stat accent" : "stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
