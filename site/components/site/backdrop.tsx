"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"

// Loose records drift in from the right, a dot-matrix block bites them, and they leave as dense, grid-aligned columns.
const CLOSED = [".#####..", "#######.", "########", "########", "########", "########", "#######.", ".#####.."]
const OPEN = [".#####..", "######..", "####....", "###.....", "###.....", "####....", "######..", ".#####.."]

type Dot = { x: number; y: number; v: number; r: number; seed: number }

function cssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "gray"
}

export function Backdrop() {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const [paused, setPaused] = React.useState(false)
  const pausedRef = React.useRef(false)
  pausedRef.current = paused

  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPaused(true)
  }, [])

  React.useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext("2d")
    if (!ctx) return
    let W = 0
    let H = 0
    let dpr = 1
    let dots: Dot[] = []
    let colors = { fg: "gray", accent: "lime" }
    const readColors = () => (colors = { fg: cssColor("--foreground"), accent: cssColor("--canvas-accent") })

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = el.clientWidth
      H = el.clientHeight
      el.width = W * dpr
      el.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const n = Math.round(Math.min(420, (W * H) / 4200))
      dots = Array.from({ length: n }, () => spawn(true))
    }
    const geometry = () => {
      const cell = Math.max(10, Math.min(22, H / 30))
      const gateX = W >= 768 ? W * 0.68 : W * 0.6
      const cy = H * 0.52
      return { cell, gateX, cy }
    }
    function spawn(anywhere: boolean): Dot {
      return {
        x: anywhere ? Math.random() * W : W + Math.random() * W * 0.3,
        y: H * (0.12 + Math.random() * 0.8),
        v: 18 + Math.random() * 30,
        r: 1 + Math.random() * 2.2,
        seed: Math.random() * 1000,
      }
    }

    let last = performance.now()
    let t = 0
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!pausedRef.current) t += dt
      const { cell, gateX, cy } = geometry()
      const band = cell * CLOSED.length * 0.5
      ctx.clearRect(0, 0, W, H)

      for (const d of dots) {
        if (!pausedRef.current) d.x -= d.v * dt * (d.x < gateX ? 0.75 : 1)
        if (d.x < W * 0.18) Object.assign(d, spawn(false))
        if (d.x >= gateX) {
          // loose records: scattered, drifting, round
          const wob = Math.sin(t * 0.8 + d.seed) * 6
          ctx.globalAlpha = 0.22 + 0.25 * Math.min(1, (W - d.x) / (W * 0.25))
          ctx.fillStyle = colors.fg
          ctx.beginPath()
          ctx.arc(d.x, d.y + wob, d.r, 0, Math.PI * 2)
          ctx.fill()
        } else {
          // packed: pulled into the band behind the block and snapped to a grid of small squares
          const g = cell * 0.5
          const py = cy + ((d.y - H * 0.52) / (H * 0.4)) * band
          const sx = Math.round(d.x / g) * g
          const sy = Math.round(py / g) * g
          const fade = Math.max(0, Math.min(1, (d.x - W * 0.18) / (gateX - W * 0.18)))
          ctx.globalAlpha = 0.12 + 0.4 * fade
          ctx.fillStyle = colors.fg
          ctx.fillRect(sx - g * 0.32, sy - g * 0.32, g * 0.64, g * 0.64)
        }
      }

      // the block, mouth opening and closing as it eats
      const open = Math.floor(t * 3.2) % 2 === 0
      const shape = open ? OPEN : CLOSED
      const bx = gateX - cell * 3
      const by = cy - band
      ctx.globalAlpha = 1
      ctx.fillStyle = colors.accent
      shape.forEach((row, r) =>
        [...row].forEach((c, col) => {
          if (c !== "#") return
          const x = bx + col * cell
          const y = by + r * cell
          const s = cell * 0.78
          ctx.beginPath()
          ctx.roundRect(x, y, s, s, s * 0.22)
          ctx.fill()
        }),
      )
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }

    readColors()
    resize()
    raf = requestAnimationFrame(frame)
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    const mo = new MutationObserver(readColors)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  return (
    <>
      <canvas ref={canvas} className="pointer-events-none fixed inset-0 z-0 size-full" aria-hidden="true" />
      <Button
        variant="ghost"
        size="icon"
        className="fixed right-5 bottom-5 z-30 bg-background/40 backdrop-blur"
        aria-label={paused ? "Play the background animation" : "Pause the background animation"}
        aria-pressed={paused}
        onClick={() => setPaused((p) => !p)}
      >
        <HugeiconsIcon icon={paused ? PlayIcon : PauseIcon} strokeWidth={2} />
      </Button>
    </>
  )
}
