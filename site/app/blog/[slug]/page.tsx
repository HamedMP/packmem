import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { longDate, post, posts } from "@/lib/posts"

export const dynamicParams = false
export const generateStaticParams = () => posts.map((p) => ({ slug: p.slug }))

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = post((await params).slug)
  if (!p) return {}
  const image = { url: "og.png", width: 1200, height: 630 }
  return {
    title: `${p.title} · packmem`,
    description: p.summary,
    openGraph: { title: p.title, description: p.summary, type: "article", publishedTime: p.date, url: `blog/${p.slug}/`, images: [image] },
    twitter: { card: "summary_large_image", title: p.title, description: p.summary, images: [image] },
  }
}

export default async function PostPage({ params }: Props) {
  const p = post((await params).slug)
  if (!p) notFound()
  const { Body } = p
  return (
    <article className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href="/blog/" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
          Blog
        </Link>
        <h1 className="text-3xl font-medium tracking-tight text-balance">{p.title}</h1>
        <time dateTime={p.date} className="text-sm text-muted-foreground">
          {longDate(p.date)}
        </time>
      </div>
      <Body />
    </article>
  )
}
