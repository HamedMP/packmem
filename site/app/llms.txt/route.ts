// llms.txt (llmstxt.org): an index of the docs for language models, generated from the same pages as the site.
import { DOCS, SITE, VERSION, docUrl } from "@/lib/docs"

export const dynamic = "force-static"

export function GET() {
  const groups = [...new Set(DOCS.map((p) => p.group))]
  const body = [
    "# packmem",
    "",
    `> packmem keeps records (a list of dicts, an array of objects) as packed columns that code can still index, loop over, update and query without unpacking, in a fraction of the memory. Python, Node, WebAssembly (browsers, Cloudflare Workers) and Rust. Version ${VERSION}.`,
    "",
    `The full docs as one Markdown file: ${SITE}/llms-full.txt`,
    "",
    ...groups.flatMap((g) => [
      `## ${g}`,
      "",
      ...DOCS.filter((p) => p.group === g).map((p) => `- [${p.title}](${docUrl(p.slug)}): ${p.description}`),
      "",
    ]),
    "## Optional",
    "",
    "- [Repository](https://github.com/HamedMP/packmem): source, benchmarks with raw results, demos",
    "- [Changelog](https://github.com/HamedMP/packmem/blob/main/CHANGELOG.md): what changed in each version",
    "- [Technical report](https://github.com/HamedMP/packmem/blob/main/docs/report.md): the encodings and the measurements behind them",
    "",
  ].join("\n")
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
}
