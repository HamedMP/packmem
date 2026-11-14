import Link from "next/link"

import { Logo } from "@/components/site/logo"
import { ThemeToggle } from "@/components/site/theme-toggle"
import { Button } from "@/components/ui/button"

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-background">
      <header className="flex items-center justify-between px-5 py-6 md:px-12 md:py-8">
        <Link href="/" aria-label="packmem, home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-2">
          <Button variant="secondary" size="lg" nativeButton={false} render={<Link href="/blog/" />}>
            Blog
          </Button>
          <ThemeToggle />
        </nav>
      </header>
      <main className="mx-auto flex max-w-[44rem] flex-col gap-10 px-5 pt-8 pb-32 md:px-12">{children}</main>
    </div>
  )
}
