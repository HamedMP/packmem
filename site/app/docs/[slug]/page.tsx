import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { DocPage } from "@/components/site/doc-page"
import { DOCS } from "@/lib/docs"

export const dynamicParams = false
export const generateStaticParams = () => DOCS.filter((p) => p.slug).map((p) => ({ slug: p.slug }))

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const p = DOCS.find((d) => d.slug === slug)
  return p ? { title: `${p.title} · packmem docs`, description: p.description } : {}
}

export default async function Page({ params }: Props) {
  const { slug } = await params
  if (!DOCS.some((p) => p.slug === slug && slug)) notFound()
  return <DocPage slug={slug} />
}
