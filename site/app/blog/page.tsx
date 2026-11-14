import type { Metadata } from "next"
import Link from "next/link"

import { longDate, posts } from "@/lib/posts"

export const metadata: Metadata = {
  title: "Blog · packmem",
  description: "Releases and measurements from packmem.",
}

export default function BlogIndex() {
  return (
    <>
      <h1 className="text-3xl font-medium tracking-tight">Blog</h1>
      <ol className="flex flex-col gap-8">
        {posts.map((p) => (
          <li key={p.slug} className="flex flex-col gap-1.5">
            <time dateTime={p.date} className="text-xs text-muted-foreground">
              {longDate(p.date)}
            </time>
            <Link href={`/blog/${p.slug}/`} className="text-lg font-medium tracking-tight underline-offset-4 hover:underline">
              {p.title}
            </Link>
            <p className="text-sm leading-relaxed text-muted-foreground">{p.summary}</p>
          </li>
        ))}
      </ol>
    </>
  )
}
