// The link preview for posts and chats, rendered once at build time from the same results files as the page.
// A route named og.png, rather than the opengraph-image convention, so the static export writes a file that
// GitHub Pages serves as image/png.
import { ImageResponse } from "next/og"

import * as d from "@/lib/data"

const fmt = (v: number) => (v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString("en-US"))
const LIST = fmt(d.hero.a)
const PACKED = fmt(d.hero.b)

const size = { width: 1200, height: 630 }
export const dynamic = "force-static"

const C = { bg: "#151613", fg: "#f4f4ef", muted: "#9b9d8e", faint: "#4b4d44", lime: "#a6e22e" }

// The logo's dot matrix, as in app/icon.svg: columns per row of a 4-unit grid, plus the byte being eaten.
const ROWS: [number, number[]][] = [
  [4, [6, 10, 14, 18]],
  [8, [2, 6, 10, 14, 18, 22]],
  [12, [2, 6, 10, 14, 18, 22, 26]],
  [16, [2, 6, 10, 14, 18, 22, 26]],
  [20, [2, 6, 10, 14, 18, 22]],
  [24, [6, 10, 14, 18]],
]

function Logo({ scale }: { scale: number }) {
  const dot = (x: number, y: number, opacity = 1) => (
    <div
      key={`${x}-${y}`}
      style={{ position: "absolute", left: x * scale, top: y * scale, width: 3.2 * scale, height: 3.2 * scale, borderRadius: 0.8 * scale, background: C.lime, opacity }}
    />
  )
  return (
    <div style={{ position: "relative", width: 32 * scale, height: 32 * scale, display: "flex" }}>
      {ROWS.flatMap(([y, xs]) => xs.map((x) => dot(x, y)))}
      {dot(28, 14, 0.55)}
    </div>
  )
}

export function GET() {
  const ratio = Math.round(d.hero.a / d.hero.b)
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "60px 72px", background: C.bg, color: C.fg }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <Logo scale={2.2} />
          <div style={{ fontSize: 42, letterSpacing: -1 }}>packmem</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 28, fontSize: 196, letterSpacing: -9, lineHeight: 1 }}>
            <span style={{ color: C.lime }}>{`${ratio}×`}</span>
            <span style={{ fontSize: 96, letterSpacing: -3 }}>less memory</span>
          </div>
          <div style={{ fontSize: 40, color: C.muted, letterSpacing: -0.5 }}>
            {`A ${LIST} MB list of dicts → ${PACKED} MB, still queryable.`}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, color: C.muted }}>
          <span>Python · Node · Rust</span>
          <span>hamedmp.github.io/packmem</span>
        </div>
      </div>
    ),
    size,
  )
}
