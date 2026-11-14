"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"

import { fmt, less, mb, speed, type Unit } from "@/lib/format"

// ---------- pieces ----------

/** A mark that shows its values on hover and keyboard focus. Values are also in the table view. */
function Mark({ title, rows, className, style, children }: { title: string; rows: [string, string][]; className?: string; style?: React.CSSProperties; children?: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div tabIndex={0} className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring", className)} style={style} />}>{children}</TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-0.5">
          <span className="opacity-70">{title}</span>
          {rows.map(([k, v]) => (
            <span key={k + v} className="flex justify-between gap-4">
              <span className="opacity-70">{k}</span>
              <b className="tabular-nums">{v}</b>
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

export function Legend({ items }: { items: { label: string; className: string; shape?: "dot" | "line" | "square" }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2">
          <span className={cn(i.className, i.shape === "line" ? "h-0.5 w-4 rounded-full" : i.shape === "square" ? "size-2.5 rounded-[3px]" : "size-2.5 rounded-full")} />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

export function NumbersTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="link" size="sm" className="h-auto px-0 text-muted-foreground" />}>Show the numbers</CollapsibleTrigger>
      <CollapsibleContent>
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              {head.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                {r.map((c, j) => (
                  <TableCell key={j} className={cn(j > 0 && "text-right tabular-nums")}>
                    {c}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Figure({ title, sub, note, children }: { title: string; sub?: string; note?: string; children: React.ReactNode }) {
  return (
    <figure className="flex flex-col gap-4 rounded-xl border bg-card/70 p-5 backdrop-blur-sm">
      <figcaption className="flex flex-col gap-1">
        <span className="font-medium">{title}</span>
        {sub && <span className="text-sm text-muted-foreground">{sub}</span>}
      </figcaption>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </figure>
  )
}

// ---------- charts ----------

/** One series of horizontal bars: packmem carries the accent, every other holder stays neutral. */
export function HBars({ rows, unit = "mb" }: { rows: { label: string; value: number; hi?: boolean }[]; unit?: Unit }) {
  const max = Math.max(...rows.map((r) => r.value))
  const f = fmt(unit)
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <Mark key={r.label} title={r.label} rows={[["", f(r.value)]]} className="grid grid-cols-[minmax(0,40%)_1fr] items-center gap-3 rounded-md text-sm">
          <span className={cn("truncate text-muted-foreground", r.hi && "font-medium text-foreground")}>{r.label}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("h-4 shrink-0 rounded-r-[4px]", r.hi ? "bg-series-pm" : "bg-series-base")} style={{ width: `${Math.max(0.6, (r.value / max) * 78)}%` }} />
            <span className={cn("text-xs whitespace-nowrap tabular-nums text-muted-foreground", r.hi && "font-medium text-foreground")}>{f(r.value)}</span>
          </span>
        </Mark>
      ))}
    </div>
  )
}

/** 100% stacked bars of three parts. */
export function Stacked({ rows, names }: { rows: { label: string; parts: number[] }[]; names: string[] }) {
  const fills = ["bg-series-pm", "bg-series-base", "bg-series-third"]
  // the accent is light in both themes, so it takes dark ink; the neutrals flip with the theme
  const inks = ["text-[oklch(0.153_0.006_107.1)]", "text-foreground", "text-foreground"]
  return (
    <div className="flex flex-col gap-3">
      <Legend items={names.map((n, i) => ({ label: n, className: fills[i], shape: "square" }))} />
      {rows.map((r) => {
        const tot = r.parts.reduce((a, b) => a + b, 0)
        return (
          <div key={r.label} className="grid grid-cols-[5.5rem_1fr] items-center gap-3 text-sm">
            <span className="text-muted-foreground">{r.label}</span>
            <div className="flex h-5 gap-0.5">
              {r.parts.map((p, i) => {
                const pct = (p / tot) * 100
                return (
                  <Mark key={i} title={r.label} rows={[[names[i], `${Math.round(pct)}% of words`]]} className={cn("flex min-w-0 items-center px-1.5 first:rounded-l-[4px] last:rounded-r-[4px]", fills[i])} style={{ width: `${pct}%` }}>
                    {pct >= 14 && <span className={cn("text-[11px] font-medium", inks[i])}>{Math.round(pct)}%</span>}
                  </Mark>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const logPos = (v: number, lo: number, hi: number) => ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100
const linPos = (v: number, lo: number, hi: number) => ((v - lo) / (hi - lo)) * 100

/** Before and after per row: baseline in neutral, packmem in the accent, joined by a line. */
export function Dumbbell({
  rows,
  unit,
  log = false,
  lo,
  hi,
  ticks,
  aName,
  bName = "packmem",
  verdict,
}: {
  rows: { label: string; a: number; b: number }[]
  unit: Unit
  log?: boolean
  lo: number
  hi: number
  ticks: number[]
  aName: string
  bName?: string
  verdict: "memory" | "time"
}) {
  const f = fmt(unit)
  const pos = (v: number) => Math.round(Math.max(0, Math.min(100, log ? logPos(v, lo, hi) : linPos(v, lo, hi))) * 1e4) / 1e4
  const tick = (t: number, i: number) => (i === ticks.length - 1 ? f(t) : f(t).replace(/ (MB|ms)$/, "")).replace(/\.0( |$)/, "$1")
  return (
    <div className="flex flex-col gap-3">
      <Legend items={[{ label: aName, className: "bg-series-base" }, { label: bName, className: "bg-series-pm" }]} />
      <div className="flex flex-col">
        {rows.map((r) => {
          const v = verdict === "memory" ? { text: less(r.a, r.b), good: r.b < r.a } : speed(r.a, r.b)
          const [pa, pb] = [pos(r.a), pos(r.b)]
          return (
            <Mark
              key={r.label}
              title={r.label}
              rows={[[aName, f(r.a)], [bName, f(r.b)], ["", v.text]]}
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-md py-1.5 text-sm hover:bg-muted/50 sm:grid-cols-[minmax(0,32%)_1fr_6.5rem]"
            >
              <span className="col-span-2 truncate text-muted-foreground sm:col-span-1">{r.label}</span>
              <span className="relative h-5">
                {ticks.map((t) => (
                  <span key={t} className="absolute inset-y-0 w-px bg-border" style={{ left: `${pos(t)}%` }} />
                ))}
                <span className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-muted-foreground/40" style={{ left: `${Math.min(pa, pb)}%`, width: `${Math.round(Math.abs(pa - pb) * 1e4) / 1e4}%` }} />
                <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-series-base ring-2 ring-card" style={{ left: `${pa}%` }} />
                <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-series-pm ring-2 ring-card" style={{ left: `${pb}%` }} />
              </span>
              <span className={cn("text-right text-xs font-medium whitespace-nowrap", v.good === false ? "text-destructive" : v.good ? "text-foreground" : "text-muted-foreground")}>{v.text}</span>
            </Mark>
          )
        })}
        <div className="grid grid-cols-[1fr_auto] gap-3 sm:grid-cols-[minmax(0,32%)_1fr_6.5rem]">
          <span className="hidden sm:block" />
          <span className="relative h-4 text-[11px] text-muted-foreground tabular-nums">
            {ticks.map((t, i) => (
              <span key={t} className={cn("absolute whitespace-nowrap", i === 0 ? "" : i === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${pos(t)}%` }}>
                {tick(t, i)}
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Two lines on log-log axes with a crosshair readout. */
export function LogLines({ points, aName, bName = "packmem", xTicks, yTicks, xLo, xHi, yLo, yHi }: { points: { x: number; a: number; b: number }[]; aName: string; bName?: string; xTicks: number[]; yTicks: number[]; xLo: number; xHi: number; yLo: number; yHi: number }) {
  const X = (x: number) => logPos(x, xLo, xHi)
  const Y = (y: number) => 100 - logPos(y, yLo, yHi)
  const path = (k: "a" | "b") => points.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(3)},${Y(p[k]).toFixed(3)}`).join(" ")
  const [i, setI] = React.useState<number | null>(null)
  const area = React.useRef<HTMLDivElement>(null)
  const last = points[points.length - 1]
  const onMove = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect()
    const pct = ((e.clientX - r.left) / r.width) * 100
    setI(points.reduce((best, p, j) => (Math.abs(X(p.x) - pct) < Math.abs(X(points[best].x) - pct) ? j : best), 0))
  }
  const cur = i === null ? null : points[i]
  const label = (t: number) => (t >= 1e6 ? `${t / 1e6}M` : t >= 1e3 ? `${t / 1e3}K` : `${t}`)
  return (
    <div className="flex flex-col gap-3">
      <Legend items={[{ label: aName, className: "bg-series-base", shape: "line" }, { label: bName, className: "bg-series-pm", shape: "line" }]} />
      <div className="grid grid-cols-[3rem_1fr_3.5rem] grid-rows-[13rem_1.25rem] text-[11px] text-muted-foreground tabular-nums">
        <div className="relative">
          {yTicks.map((t, i) => (
            <span key={t} className="absolute right-2 -translate-y-1/2 whitespace-nowrap" style={{ top: `${Y(t)}%` }}>
              {i === yTicks.length - 1 ? mb(t).replace(/\.0 /, " ") : mb(t).replace(/(\.0)? MB$/, "")}
            </span>
          ))}
        </div>
        <div
          ref={area}
          tabIndex={0}
          aria-label={`${aName} and ${bName} memory by number of rows`}
          className="relative border-b border-l outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={onMove}
          onPointerLeave={() => setI(null)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
            e.preventDefault()
            setI((v) => Math.max(0, Math.min(points.length - 1, (v ?? points.length - 1) + (e.key === "ArrowRight" ? 1 : -1))))
          }}
        >
          {yTicks.map((t) => (
            <span key={t} className="absolute inset-x-0 h-px bg-border" style={{ top: `${Y(t)}%` }} />
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
            <path d={path("a")} className="fill-none stroke-series-base" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            <path d={path("b")} className="fill-none stroke-series-pm" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          <span className="absolute size-2.5 -translate-1/2 rounded-full bg-series-base ring-2 ring-card" style={{ left: `${X(last.x)}%`, top: `${Y(last.a)}%` }} />
          <span className="absolute size-2.5 -translate-1/2 rounded-full bg-series-pm ring-2 ring-card" style={{ left: `${X(last.x)}%`, top: `${Y(last.b)}%` }} />
          <span className="absolute left-[calc(100%+0.5rem)] -translate-y-1/2 whitespace-nowrap" style={{ top: `${Y(last.a)}%` }}>{mb(last.a)}</span>
          <span className="absolute left-[calc(100%+0.5rem)] -translate-y-1/2 whitespace-nowrap" style={{ top: `${Y(last.b)}%` }}>{mb(last.b)}</span>
          {cur && (
            <>
              <span className="pointer-events-none absolute inset-y-0 w-px bg-muted-foreground" style={{ left: `${X(cur.x)}%` }} />
              <div className="pointer-events-none absolute top-2 z-10 rounded-md bg-foreground px-3 py-1.5 text-xs text-background" style={{ left: `min(${X(cur.x)}%, calc(100% - 9rem))` }}>
                <div className="opacity-70">{cur.x.toLocaleString("en-US")} rows</div>
                <div className="flex justify-between gap-3"><span className="opacity-70">{aName}</span><b>{mb(cur.a)}</b></div>
                <div className="flex justify-between gap-3"><span className="opacity-70">{bName}</span><b>{mb(cur.b)}</b></div>
              </div>
            </>
          )}
        </div>
        <div />
        <div />
        <div className="relative">
          {xTicks.map((t) => (
            <span key={t} className="absolute top-1 -translate-x-1/2" style={{ left: `${X(t)}%` }}>
              {label(t)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Compact before/after bars for a narrow card: label and value on one line, a thin bar under it. packmem rows take
 * the accent; the bar keeps a visible sliver however small its value. */
export function CompareBars({ rows, unit = "mb", caption }: { rows: { label: string; value: number; hi?: boolean }[]; unit?: Unit; caption?: string }) {
  const max = Math.max(...rows.map((r) => r.value))
  const f = fmt(unit)
  return (
    <figure className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <Mark key={r.label} title={r.label} rows={[["", f(r.value)]]} className="flex flex-col gap-1 rounded-md">
          <span className="flex items-baseline justify-between gap-3 text-xs">
            <span className={cn("truncate text-muted-foreground", r.hi && "text-foreground")}>{r.label}</span>
            <span className={cn("shrink-0 tabular-nums text-muted-foreground", r.hi && "font-medium text-foreground")}>{f(r.value)}</span>
          </span>
          <span className="block h-2 w-full rounded-full bg-muted/60">
            <span className={cn("block h-2 rounded-full", r.hi ? "bg-series-pm" : "bg-series-base")} style={{ width: `${Math.max(1.2, (r.value / max) * 100)}%` }} />
          </span>
        </Mark>
      ))}
      {caption && <figcaption className="text-[11px] text-muted-foreground">{caption}</figcaption>}
    </figure>
  )
}
