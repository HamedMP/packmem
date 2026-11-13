"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"
import { mb } from "@/lib/format"
import { Button } from "@/components/ui/button"

// The first six rows of nycflights13, as they are in the flights file.
const ROWS = [
  { year: 2013, carrier: "UA", dest: "IAH", arr_delay: 11 },
  { year: 2013, carrier: "UA", dest: "IAH", arr_delay: 20 },
  { year: 2013, carrier: "AA", dest: "MIA", arr_delay: 33 },
  { year: 2013, carrier: "B6", dest: "BQN", arr_delay: -18 },
  { year: 2013, carrier: "DL", dest: "ATL", arr_delay: -25 },
  { year: 2013, carrier: "UA", dest: "ORD", arr_delay: 12 },
]
const FIELDS = ["year", "carrier", "dest", "arr_delay"] as const
type Field = (typeof FIELDS)[number]

// What packmem picks for these columns of the full flights table (Table.describe()).
const ENCODING: Record<Field, string> = {
  year: "constant",
  carrier: "dictionary, 4 bits",
  dest: "dictionary, 8 bits",
  arr_delay: "offset from min",
}

const dictOf = (f: "carrier" | "dest") => [...new Set(ROWS.map((r) => r[f]))]
const DICT = { carrier: dictOf("carrier"), dest: dictOf("dest") }
const MIN = Math.min(...ROWS.map((r) => r.arr_delay))
const code = (f: Field, i: number) => {
  const r = ROWS[i]
  if (f === "year") return String(r.year)
  if (f === "arr_delay") return String(r.arr_delay - MIN)
  return String(DICT[f].indexOf(r[f]))
}
const MATCH = ROWS.map((r) => r.carrier === "UA")
const JSON_LINES = ROWS.filter((_, i) => MATCH[i]).map((r) => JSON.stringify(r))

const SCENES = [
  { title: "A list of dicts", text: "Every record is an object, and every value in it is wrapped again: an object header, a pointer, a hash slot." },
  { title: "One column per field", text: "packmem takes the values out of the records and keeps each field as one column. The wrappers are never created." },
  { title: "An encoding per column", text: "A sample of each 16,384-row chunk picks the encoding: one constant, a dictionary and small codes, offsets from the minimum." },
  { title: "Queries read the codes", text: "count(carrier=\"UA\") looks up UA's code once, then compares 4-bit codes. No record is rebuilt to answer it." },
  { title: "JSON straight from the columns", text: "Matching rows are written as JSON from the columns into the response, without an object per row in between." },
] as const
const DURATION = [3800, 3200, 4600, 4400, 5200]

// ---------- geometry: one 600-wide drawing, top to bottom ----------
const W = 600
const VH = 560
const EASE = "cubic-bezier(0.22, 0.8, 0.24, 1)"
const H = 28
const BAR_X = 100
const BAR_MAX = 400
const CODE_Y = 102
const COL_X = (j: number) => 4 + j * 150
const COL_W = 132
const HEAD_Y = 146
const ROW_Y = (i: number) => 176 + i * 38
const BELOW_Y = 412
const CARD_X = [20, 46, 30, 56, 38, 24]
const CARD_Y = (i: number) => 128 + i * 62
const STEP = 110
const CARD_W = 34 + FIELDS.length * STEP

type Pos = { x: number; y: number; w: number; o: number }

function tokenPos(scene: number, i: number, j: number): Pos {
  const f = FIELDS[j]
  if (scene === 0) return { x: CARD_X[i] + 34 + j * STEP + 22, y: CARD_Y(i) + 8, w: 80, o: 1 }
  if (scene === 1) return { x: COL_X(j), y: ROW_Y(i), w: COL_W, o: 1 }
  if (f === "year") return { x: COL_X(j), y: ROW_Y(0), w: COL_W, o: i === 0 ? 1 : 0 }
  const w = f === "arr_delay" ? 56 : 40
  return { x: COL_X(j) + (COL_W - w) / 2, y: ROW_Y(i), w, o: 1 }
}

const REDUCED = "(prefers-reduced-motion: reduce)"
const subscribeReduced = (on: () => void) => {
  const m = window.matchMedia(REDUCED)
  m.addEventListener("change", on)
  return () => m.removeEventListener("change", on)
}
const usePrefersReducedMotion = () =>
  React.useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED).matches, () => false)

export function HowItWorks({ listMb, packedMb, records }: { listMb: number; packedMb: number; records: number }) {
  const reduced = usePrefersReducedMotion()
  const [scene, setScene] = React.useState(0)
  // null until the reader presses play or pause; until then, play unless they asked for reduced motion
  const [choice, setChoice] = React.useState<boolean | null>(null)
  const playing = choice ?? !reduced
  const [visible, setVisible] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.35 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  React.useEffect(() => {
    if (!playing || !visible) return
    const t = window.setTimeout(() => setScene((s) => (s + 1) % SCENES.length), DURATION[scene])
    return () => window.clearTimeout(t)
  }, [scene, playing, visible])

  const go = (s: number) => {
    setScene(s)
    setChoice(false)
  }

  const move = (delay = 0) => (reduced ? undefined : `transform 900ms ${EASE} ${delay}ms, opacity 500ms ease ${delay}ms`)
  const fade = (delay = 0) => (reduced ? undefined : `opacity 450ms ease ${delay}ms, fill 450ms ease ${delay}ms`)
  const packed = scene >= 2
  const packedW = Math.max(3, (BAR_MAX * packedMb) / listMb)

  return (
    <div ref={ref} className="flex flex-col gap-4">
      <div className="-mx-1 overflow-x-auto px-1">
        <svg
          viewBox={`0 0 ${W} ${VH}`}
          className="block w-full min-w-[480px] select-none"
          role="img"
          aria-label="How packmem works: a list of dicts becomes one encoded column per field, queries compare small codes, and JSON is written straight from the columns."
        >
          {/* ---------- memory ---------- */}
          <text x={0} y={12} className="fill-muted-foreground text-[11px]">
            Resident memory, {records.toLocaleString("en-US")} flights in Python
          </text>
          <text x={0} y={40} className="fill-foreground text-[12px]">list of dicts</text>
          <rect x={BAR_X} y={31} width={BAR_MAX} height={10} rx={3} className="fill-muted-foreground" />
          <text x={BAR_X + BAR_MAX + 8} y={40} className="fill-foreground font-mono text-[12px] tabular-nums">{mb(listMb)}</text>
          <g style={{ opacity: packed ? 1 : 0, transition: fade(packed ? 900 : 0) }}>
            <text x={0} y={64} className="fill-foreground text-[12px]">packmem</text>
            <rect x={BAR_X} y={55} width={packedW} height={10} rx={3} className="fill-primary" />
            <text x={BAR_X + packedW + 8} y={64} className="fill-foreground font-mono text-[12px] tabular-nums">{mb(packedMb)}</text>
          </g>

          {/* ---------- the code ---------- */}
          <g className="font-mono text-[12px]">
            {[
              { on: scene === 0, line: "rows = [json.loads(l) for l in f]" },
              { on: scene === 1 || scene === 2, line: 'rows = packmem.load_jsonl("flights.jsonl")' },
              { on: scene === 3, line: 'rows.count(carrier="UA")' },
              { on: scene === 4, line: 'rows.where(carrier="UA").to_json()' },
            ].map((c) => (
              <text key={c.line} x={0} y={CODE_Y} className="fill-foreground" style={{ opacity: c.on ? 1 : 0, transition: fade(c.on ? 250 : 0) }}>
                <tspan className="fill-muted-foreground">{">>> "}</tspan>
                {c.line}
              </text>
            ))}
            <text x={240} y={CODE_Y} className="fill-foreground font-medium" style={{ opacity: scene === 3 ? 1 : 0, transition: fade(scene === 3 ? 1500 : 0) }}>
              <tspan className="fill-muted-foreground">{"→ "}</tspan>
              {MATCH.filter(Boolean).length}
            </text>
          </g>

          {/* ---------- objects: the list, the cards and the wrappers ---------- */}
          <g style={{ opacity: scene === 0 ? 1 : 0, transition: fade() }}>
            <g className="text-[11px]">
              <rect x={330} y={113} width={10} height={10} rx={2} className="fill-chart-2" opacity={0.55} />
              <text x={345} y={122} className="fill-muted-foreground">object header</text>
              <rect x={432} y={113} width={10} height={10} rx={2} className="fill-chart-2" opacity={0.35} />
              <text x={447} y={122} className="fill-muted-foreground">key, hash, pointer</text>
            </g>
            <line x1={6} x2={6} y1={CARD_Y(0) + 22} y2={CARD_Y(5) + 22} className="stroke-border" strokeWidth={2} />
            {ROWS.map((_, i) => (
              <g key={i}>
                <line x1={6} x2={CARD_X[i]} y1={CARD_Y(i) + 22} y2={CARD_Y(i) + 22} className="stroke-chart-2" strokeWidth={1.5} strokeDasharray="2 3" />
                <circle cx={6} cy={CARD_Y(i) + 22} r={3} className="fill-chart-2" />
                <rect x={CARD_X[i]} y={CARD_Y(i)} width={CARD_W} height={44} rx={9} className="fill-card stroke-border" strokeWidth={1} />
                <rect x={CARD_X[i] + 8} y={CARD_Y(i) + 8} width={20} height={H} rx={4} className="fill-chart-2" opacity={0.55} />
                {FIELDS.map((_, j) => (
                  <rect key={j} x={CARD_X[i] + 34 + j * STEP} y={CARD_Y(i) + 8} width={18} height={H} rx={4} className="fill-chart-2" opacity={0.35} />
                ))}
              </g>
            ))}
          </g>

          {/* ---------- column headers and encodings ---------- */}
          {FIELDS.map((f, j) => (
            <g key={f} style={{ opacity: scene >= 1 ? 1 : 0, transition: fade(scene === 1 ? 300 : 0) }}>
              <text x={COL_X(j)} y={HEAD_Y} className="fill-foreground font-mono text-[13px] font-medium">{f}</text>
              <text x={COL_X(j)} y={HEAD_Y + 17} className="fill-muted-foreground text-[11px]" style={{ opacity: packed ? 1 : 0, transition: fade(packed ? 500 : 0) }}>
                {ENCODING[f]}
              </text>
            </g>
          ))}

          {/* ---------- the values ---------- */}
          {ROWS.map((r, i) =>
            FIELDS.map((f, j) => {
              const p = tokenPos(scene, i, j)
              const hit = (scene === 3 && f === "carrier" && MATCH[i]) || (scene === 4 && MATCH[i])
              const dim = (scene === 3 && f !== "carrier") || (scene === 4 && !MATCH[i])
              const delay = scene === 1 ? i * 60 + j * 40 : scene === 2 ? j * 160 : scene === 3 ? 500 + i * 140 : 0
              const vw = scene === 0 ? 80 : COL_W
              return (
                <g key={`${i}-${f}`} style={{ transform: `translate(${p.x}px, ${p.y}px)`, opacity: p.o * (dim ? 0.3 : 1), transition: move(delay) }}>
                  <rect
                    width={p.w}
                    height={H}
                    rx={6}
                    className={cn(hit ? "fill-primary" : packed ? "fill-muted stroke-chart-2" : "fill-muted stroke-border")}
                    strokeWidth={1}
                    style={{ width: p.w, transition: reduced ? undefined : `width 700ms ${EASE} ${delay}ms, fill 400ms ease ${delay}ms` }}
                  />
                  <text x={vw / 2} y={18.5} textAnchor="middle" className="fill-foreground font-mono text-[12px]" style={{ opacity: packed ? 0 : 1, transition: fade(delay) }}>
                    {String(r[f])}
                  </text>
                  <text
                    x={p.w / 2}
                    y={18.5}
                    textAnchor="middle"
                    className={cn("font-mono text-[12px]", hit ? "fill-primary-foreground font-medium" : "fill-foreground")}
                    style={{ opacity: packed ? 1 : 0, transition: fade(delay + 200) }}
                  >
                    {code(f, i)}
                  </text>
                </g>
              )
            }),
          )}

          {/* ---------- below the columns: dictionaries, then the JSON ---------- */}
          <g style={{ opacity: packed && scene !== 4 ? 1 : 0, transition: fade(packed && scene !== 4 ? 600 : 0) }}>
            {(["carrier", "dest"] as const).map((f) => {
              const j = FIELDS.indexOf(f)
              return DICT[f].map((v, k) => {
                const lit = scene === 3 && f === "carrier" && k === 0
                return (
                  <g key={f + v} style={{ opacity: scene === 3 && f !== "carrier" ? 0.3 : 1, transition: fade() }}>
                    <rect x={COL_X(j)} y={BELOW_Y + k * 22} width={COL_W} height={20} rx={4} className={lit ? "fill-primary" : "fill-transparent"} style={{ transition: fade(200) }} />
                    <text x={COL_X(j) + 10} y={BELOW_Y + 14 + k * 22} className={cn("font-mono text-[12px]", lit ? "fill-primary-foreground" : "fill-muted-foreground")}>
                      {k}
                    </text>
                    <text x={COL_X(j) + 34} y={BELOW_Y + 14 + k * 22} className={cn("font-mono text-[12px]", lit ? "fill-primary-foreground" : "fill-foreground")}>
                      {v}
                    </text>
                  </g>
                )
              })
            })}
            <g style={{ opacity: scene === 3 ? 0.3 : 1, transition: fade() }}>
              <text x={COL_X(0) + 10} y={BELOW_Y + 14} className="fill-muted-foreground text-[12px]">stored once</text>
              <text x={COL_X(3) + 10} y={BELOW_Y + 14} className="fill-foreground font-mono text-[12px]">min {MIN}</text>
            </g>
          </g>
          <g className="font-mono text-[12px]">
            {["[", ...JSON_LINES.map((l, k) => l + (k < JSON_LINES.length - 1 ? "," : "")), "]"].map((l, k, all) => (
              <text
                key={k}
                x={k === 0 || k === all.length - 1 ? 0 : 14}
                y={BELOW_Y + 8 + k * 22}
                className="fill-foreground"
                style={{ opacity: scene === 4 ? 1 : 0, transition: fade(scene === 4 ? 400 + k * 320 : 0) }}
              >
                {l}
              </text>
            ))}
          </g>
        </svg>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-h-16 flex-col gap-1">
          <span className="font-medium">
            <span className="mr-2 font-mono text-xs text-muted-foreground tabular-nums">
              {scene + 1}/{SCENES.length}
            </span>
            {SCENES[scene].title}
          </span>
          <span className="max-w-md text-sm leading-relaxed text-muted-foreground">{SCENES[scene].text}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={playing ? "Pause" : "Play"} onClick={() => setChoice(!playing)}>
            <HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} strokeWidth={2} />
          </Button>
          {SCENES.map((s, k) => (
            <button
              key={s.title}
              type="button"
              aria-label={`Step ${k + 1}: ${s.title}`}
              aria-current={k === scene ? "step" : undefined}
              onClick={() => go(k)}
              className="group flex h-8 items-center px-1 outline-none"
            >
              <span
                className={cn(
                  "block h-1.5 rounded-full transition-all group-focus-visible:ring-2 group-focus-visible:ring-ring",
                  k === scene ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/40 group-hover:bg-muted-foreground",
                )}
              />
            </button>
          ))}
        </div>
      </div>
      <ol className="sr-only">
        {SCENES.map((s) => (
          <li key={s.title}>
            {s.title}: {s.text}
          </li>
        ))}
      </ol>
    </div>
  )
}
