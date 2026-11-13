// Number formatting shared by server-rendered prose and client charts.
const nf = new Intl.NumberFormat("en-US")
export const mb = (v: number) => (v < 10 ? v.toFixed(1) : nf.format(Math.round(v))) + " MB"
export const ms = (v: number) => (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : nf.format(Math.round(v))) + " ms"
export type Unit = "mb" | "ms"
export const fmt = (u: Unit) => (u === "mb" ? mb : ms)
export function less(a: number, b: number) {
  const r = a / b
  return r >= 1 ? `${r >= 10 ? Math.round(r) : r.toFixed(1)}× less` : `${(1 / r).toFixed(1)}× more`
}
export function speed(a: number, b: number): { text: string; good: boolean | null } {
  const r = a / b
  if (r > 1.1) return { text: `${r >= 10 ? nf.format(Math.round(r)) : r.toFixed(1)}× faster`, good: true }
  if (r < 0.9) return { text: `${(1 / r).toFixed(1)}× slower`, good: false }
  return { text: "about the same", good: null }
}
