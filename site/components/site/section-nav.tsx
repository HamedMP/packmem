"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export type NavSection = { id: string; title: string; summary: string }

const REDUCED = "(prefers-reduced-motion: reduce)"

/** A tick per section at the right edge. The current section's tick is longer; hovering or focusing a tick shows its
 * title and a one-line summary, and clicking scrolls there. The page scrolls inside <main>, so that is the root. */
export function SectionNav({ sections }: { sections: NavSection[] }) {
  const [active, setActive] = React.useState(sections[0]?.id)
  const [shown, setShown] = React.useState<string | null>(null)

  React.useEffect(() => {
    const root = document.querySelector("main")
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e)
    if (!root || !els.length) return
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (hit) setActive(hit.target.id)
      },
      { root, rootMargin: "-30% 0px -60% 0px" },
    )
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [sections])

  const go = (id: string) => {
    const smooth = !window.matchMedia(REDUCED).matches
    document.getElementById(id)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" })
    setActive(id)
  }

  return (
    <nav aria-label="Sections" className="fixed top-1/2 right-5 z-20 hidden -translate-y-1/2 lg:block" onMouseLeave={() => setShown(null)}>
      <ol className="flex flex-col items-end gap-2.5">
        {sections.map((s) => {
          const on = s.id === active
          return (
            <li key={s.id} className="relative">
              <button
                type="button"
                aria-label={s.title}
                aria-current={on ? "location" : undefined}
                onClick={() => go(s.id)}
                onMouseEnter={() => setShown(s.id)}
                onFocus={() => setShown(s.id)}
                onBlur={() => setShown(null)}
                className="group flex h-3 w-8 items-center justify-end outline-none"
              >
                <span
                  className={cn(
                    "block h-0.5 rounded-full transition-all duration-200 group-focus-visible:ring-2 group-focus-visible:ring-ring",
                    on ? "w-7 bg-foreground" : "w-4 bg-muted-foreground/45 group-hover:w-5 group-hover:bg-muted-foreground",
                  )}
                />
              </button>
              {shown === s.id && (
                <div
                  role="tooltip"
                  className="pointer-events-none absolute top-1/2 right-11 w-72 -translate-y-1/2 rounded-xl border bg-popover/95 px-4 py-3 text-left text-popover-foreground shadow-lg backdrop-blur"
                >
                  <p className="truncate text-sm font-medium">{s.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.summary}</p>
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
