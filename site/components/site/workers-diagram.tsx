// What a data loader does with its records: left, every worker process gets its own copy; right, the parent and every
// worker read one memory-mapped file. Drawn, not measured; the bars next to it carry the numbers.

const W = 600
const H = 150
const BOX_W = 50
const BOX_H = 58
const GAP = 10

function Process({ x, y, label, fill }: { x: number; y: number; label: string; fill: number }) {
  return (
    <g>
      <rect x={x} y={y} width={BOX_W} height={BOX_H} rx={7} className="fill-card stroke-border" strokeWidth={1} />
      {fill > 0 && <rect x={x + 7} y={y + BOX_H - 7 - fill} width={BOX_W - 14} height={fill} rx={3} className="fill-series-base" />}
      <text x={x + BOX_W / 2} y={y + BOX_H + 15} textAnchor="middle" className="fill-muted-foreground text-[10.5px]">
        {label}
      </text>
    </g>
  )
}

export function WorkersDiagram({ left, right }: { left: string; right: string }) {
  const panel = (x0: number, copies: boolean) => {
    const names = ["parent", "worker", "worker", "worker", "worker"]
    const top = 30
    return (
      <g>
        {names.map((n, i) => (
          <Process key={i} x={x0 + i * (BOX_W + GAP)} y={top} label={n} fill={copies ? 40 : 4} />
        ))}
        {!copies && (
          <g>
            <rect x={x0} y={top + BOX_H + 28} width={5 * BOX_W + 4 * GAP} height={12} rx={4} className="fill-series-pm" />
            {names.map((_, i) => (
              <line
                key={i}
                x1={x0 + i * (BOX_W + GAP) + BOX_W / 2}
                x2={x0 + i * (BOX_W + GAP) + BOX_W / 2}
                y1={top + BOX_H + 19}
                y2={top + BOX_H + 28}
                className="stroke-series-pm"
                strokeWidth={1.5}
                strokeDasharray="2 3"
              />
            ))}
          </g>
        )}
      </g>
    )
  }
  const pw = 5 * BOX_W + 4 * GAP
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`${left}. ${right}.`}>
      <text x={0} y={14} className="fill-foreground text-[12px] font-medium">{left}</text>
      {panel(0, true)}
      <text x={W - pw} y={14} className="fill-foreground text-[12px] font-medium">{right}</text>
      {panel(W - pw, false)}
      <text x={W - pw} y={H - 2} className="fill-muted-foreground text-[10.5px]">one memory-mapped file</text>
    </svg>
  )
}
