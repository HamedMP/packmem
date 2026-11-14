"use client";

import { useEffect, useRef, useState } from "react";
import { fetchTable } from "packmem/http";
import { useRows } from "packmem/react";
import { init, type PackmemWasm } from "packmem/wasm";
import type { Table } from "packmem";

const CARRIERS = ["UA", "B6", "EV", "DL", "AA", "MQ", "US", "9E", "WN"];
const ROW = 28;
const SHOWN = 20;
const nf = new Intl.NumberFormat("en-US");

let pm: Promise<PackmemWasm> | undefined;

export function Browser() {
  const [carrier, setCarrier] = useState("UA");
  const [table, setTable] = useState<Table | null>(null);
  const [readyMs, setReadyMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const rows = useRows(table, { offset, limit: SHOWN });
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const t0 = performance.now();
    pm ??= init("/packmem.wasm");
    pm.then((api) => fetchTable(api, `/api/flights/export?carrier=${carrier}`))
      .then((t) => {
        if (!live) return;
        setTable(t);
        setReadyMs(performance.now() - t0);
        setOffset(0);
        if (list.current) list.current.scrollTop = 0;
        setError(null);
      })
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [carrier]);

  return (
    <>
      <nav className="filters" aria-label="Carrier">
        <div>
          <span>Carrier</span>
          {CARRIERS.map((c) => (
            <a key={c} href={`#${c}`} className={carrier === c ? "on" : ""} onClick={(e) => (e.preventDefault(), setCarrier(c))}>
              {c}
            </a>
          ))}
        </div>
      </nav>

      {error && <p className="card">{error}</p>}

      <section className="stats" aria-label="Table">
        <div className="stat"><span>Rows</span><strong>{table ? nf.format(table.length) : "…"}</strong></div>
        <div className="stat accent"><span>Fetched and opened</span><strong>{table ? `${Math.round(readyMs)} ms` : "…"}</strong></div>
        <div className="stat"><span>Objects built</span><strong>{rows.length}</strong></div>
      </section>

      <section className="card">
        <div ref={list} className="scroll" style={{ height: ROW * SHOWN, overflowY: "auto" }} onScroll={(e) => setOffset(Math.floor(e.currentTarget.scrollTop / ROW))}>
          <div style={{ height: (table?.length ?? 0) * ROW, position: "relative" }}>
            <table style={{ position: "absolute", top: offset * ROW }}>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={offset + i} style={{ height: ROW }}>
                    <td className="num">{nf.format(offset + i + 1)}</td>
                    <td>{`${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`}</td>
                    <td>{`${r.carrier} ${r.flight}`}</td>
                    <td>{`${r.origin} → ${r.dest}`}</td>
                    <td className="num">{r.dep_delay === null ? "–" : `${r.dep_delay} min`}</td>
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
