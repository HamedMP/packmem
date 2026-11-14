import Link from "next/link"

import { BASE, DOCS, docHref, renderDoc } from "@/lib/docs"
import { REPO } from "@/lib/data"

/** One docs page: its Markdown rendered at build time, with a contents list and links to the neighbouring pages. */
export async function DocPage({ slug }: { slug: string }) {
  const { html, headings, title } = await renderDoc(slug)
  const at = DOCS.findIndex((p) => p.slug === slug)
  const [prev, next] = [DOCS[at - 1], DOCS[at + 1]]
  const page = DOCS[at]
  return (
    <div className="flex gap-12">
      <article className="min-w-0 max-w-[46rem] flex-1">
        <p className="font-mono text-xs text-muted-foreground">{page.group}</p>
        <h1 className="mt-2 text-3xl font-medium tracking-tight text-balance">{title || page.title}</h1>
        <p className="mt-3 text-lg leading-relaxed text-muted-foreground">{page.description}</p>
        <div className="doc mt-8" dangerouslySetInnerHTML={{ __html: html }} />
        <nav aria-label="More docs" className="mt-16 grid gap-3 border-t pt-6 sm:grid-cols-2">
          {prev ? (
            <Link href={docHref(prev.slug)} className="rounded-lg border p-4 transition-colors hover:bg-muted">
              <span className="text-xs text-muted-foreground">Previous</span>
              <span className="block font-medium">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={docHref(next.slug)} className="rounded-lg border p-4 text-right transition-colors hover:bg-muted">
              <span className="text-xs text-muted-foreground">Next</span>
              <span className="block font-medium">{next.title}</span>
            </Link>
          )}
        </nav>
        <p className="mt-6 text-xs text-muted-foreground">
          <a className="underline underline-offset-4" href={`${REPO}/blob/main/site/content/docs/${slug || "index"}.md`}>
            Edit this page
          </a>{" "}
          · Every page as Markdown for agents:{" "}
          <a className="underline underline-offset-4" href={`${BASE}/llms-full.txt`}>
            llms-full.txt
          </a>
        </p>
      </article>
      {headings.length > 2 && (
        <aside className="sticky top-8 hidden h-fit w-44 shrink-0 xl:block">
          <p className="pb-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">On this page</p>
          <ul className="flex flex-col gap-1.5 text-sm">
            {headings.map((h) => (
              <li key={h.id}>
                <a href={`#${h.id}`} className="text-muted-foreground hover:text-foreground">
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  )
}
