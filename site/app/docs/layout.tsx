import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import { GithubIcon } from "@hugeicons/core-free-icons"

import { DocsNav } from "@/components/site/docs-nav"
import { Logo } from "@/components/site/logo"
import { ThemeToggle } from "@/components/site/theme-toggle"
import { Button } from "@/components/ui/button"
import { DOCS, docHref, VERSION } from "@/lib/docs"
import { REPO } from "@/lib/data"

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const items = DOCS.map((p) => ({ href: docHref(p.slug), title: p.title, group: p.group }))
  return (
    <div className="min-h-svh bg-background">
      <header className="flex items-center justify-between gap-2 px-4 py-6 md:px-12 md:py-8">
        <Link href="/" aria-label="packmem, home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-2">
          <Button variant="secondary" size="lg" nativeButton={false} render={<Link href="/docs/" />}>
            Docs
          </Button>
          <Button variant="secondary" size="lg" className="hidden sm:inline-flex" nativeButton={false} render={<Link href="/blog/" />}>
            Blog
          </Button>
          <Button variant="secondary" size="lg" className="gap-2 font-mono text-xs" nativeButton={false} render={<a href={REPO} />}>
            <HugeiconsIcon icon={GithubIcon} strokeWidth={2} data-icon="inline-start" />v{VERSION}
          </Button>
          <ThemeToggle />
        </nav>
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pb-32 md:flex-row md:gap-12 md:px-12">
        <DocsNav items={items} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  )
}
