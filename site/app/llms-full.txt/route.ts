// llms-full.txt: every docs page as Markdown, in sidebar order, from the same files the pages are rendered from.
import { allDocsMarkdown, VERSION } from "@/lib/docs"

export const dynamic = "force-static"

export function GET() {
  const head = `# packmem ${VERSION} documentation\n\nEvery page of https://hamedmp.github.io/packmem/docs/ as Markdown.\n\n`
  return new Response(head + allDocsMarkdown(), { headers: { "content-type": "text/plain; charset=utf-8" } })
}
