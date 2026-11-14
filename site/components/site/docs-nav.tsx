"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { cn } from "@/lib/utils"

export type NavItem = { href: string; title: string; group: string }

/** The docs' page list: a sidebar on wide screens, a collapsible menu above the page on phones. */
export function DocsNav({ items }: { items: NavItem[] }) {
  const path = usePathname()
  const here = (href: string) => path === href || path === href.replace(/\/$/, "")
  const groups = [...new Set(items.map((i) => i.group))]
  const list = (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-1">
          <p className="px-2 pb-1 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">{g}</p>
          {items
            .filter((i) => i.group === g)
            .map((i) => (
              <Link
                key={i.href}
                href={i.href}
                aria-current={here(i.href) ? "page" : undefined}
                className={cn(
                  "rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  here(i.href) && "bg-muted font-medium text-foreground",
                )}
              >
                {i.title}
              </Link>
            ))}
        </div>
      ))}
    </div>
  )
  const current = items.find((i) => here(i.href))
  return (
    <>
      <nav aria-label="Docs" className="sticky top-8 hidden max-h-[calc(100svh-4rem)] w-52 shrink-0 overflow-y-auto pb-8 md:block">
        {list}
      </nav>
      <details className="group rounded-lg border bg-muted/40 md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium">
          <span>
            <span className="text-muted-foreground">Docs · </span>
            {current?.title ?? "Pages"}
          </span>
          <span aria-hidden className="text-muted-foreground transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <nav aria-label="Docs" className="border-t px-2 py-4">
          {list}
        </nav>
      </details>
    </>
  )
}
