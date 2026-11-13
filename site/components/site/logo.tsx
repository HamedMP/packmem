import { cn } from "@/lib/utils"

// A dot-matrix block that opens a mouth and eats loose bytes: packmem packing data.
// Dots present when closed but missing when open form the mouth, which animates.
const CLOSED = [".####..", "######.", "#######", "#######", "######.", ".####.."]
const OPEN = [".####..", "#####..", "###....", "###....", "#####..", ".####.."]
const CELL = 6
const DOT = 4.6

export function LogoMark({ className }: { className?: string }) {
  const dots: { x: number; y: number; mouth: boolean }[] = []
  CLOSED.forEach((row, r) =>
    [...row].forEach((c, col) => {
      if (c === "#") dots.push({ x: col * CELL, y: r * CELL, mouth: OPEN[r][col] !== "#" })
    }),
  )
  const w = 11 * CELL
  const h = CLOSED.length * CELL
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("h-7 w-auto", className)} aria-hidden="true">
      {dots.map((d) => (
        <rect
          key={`${d.x}-${d.y}`}
          x={d.x}
          y={d.y}
          width={DOT}
          height={DOT}
          rx={1.1}
          className={cn("fill-current", d.mouth && "logo-mouth")}
        />
      ))}
      {/* bytes waiting to be eaten */}
      {[7.5, 9.5].map((col, i) => (
        <rect
          key={col}
          x={col * CELL}
          y={2.5 * CELL}
          width={DOT}
          height={DOT}
          rx={1.1}
          className="logo-byte fill-primary"
          style={{ animationDelay: `${i * -0.35}s` }}
        />
      ))}
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-3", className)}>
      <LogoMark />
      <span className="flex flex-col text-[1.35rem] leading-[0.95] font-medium tracking-tight">
        <span>pack</span>
        <span>mem</span>
      </span>
    </span>
  )
}
