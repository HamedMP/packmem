// The docs: one Markdown file per page in content/docs, rendered at build time. llms.txt and llms-full.txt are
// generated from the same files, so the pages and what agents read cannot drift apart.
import "server-only"
import { readFileSync } from "node:fs"
import path from "node:path"
import { marked, type Token, type Tokens } from "marked"

import { highlight, type Lang } from "@/lib/highlight"

const ROOT = path.resolve(process.cwd(), "..")

/** The site's public address, for absolute links in llms.txt. */
export const SITE = "https://hamedmp.github.io/packmem"

/** The version on npm and PyPI, read from the Node package so it is written in one place. */
export const VERSION: string = JSON.parse(readFileSync(path.join(ROOT, "node/package.json"), "utf8")).version

export type DocPage = { slug: string; title: string; description: string; group: string }

/** Sidebar order. `slug` "" is /docs/ itself; every other page is content/docs/<slug>.md. */
export const DOCS: DocPage[] = [
  { slug: "", group: "Start", title: "Overview", description: "What packmem is, when it helps and when it does not." },
  { slug: "install", group: "Start", title: "Install", description: "Python, Node, browsers and edge runtimes, Rust." },
  { slug: "quickstart", group: "Start", title: "Quickstart", description: "Load, query and serve records in each language." },
  { slug: "benchmarks", group: "Start", title: "Benchmarks", description: "Memory, time and bytes in training scripts, Lightdash, paperless-ngx and a log viewer." },
  { slug: "python", group: "Libraries", title: "Python", description: "packmem.Table: a list of dicts in packed columns." },
  { slug: "node", group: "Libraries", title: "Node", description: "Table and View for Node, Bun and Deno." },
  { slug: "browser", group: "Libraries", title: "Browsers and edge", description: "packmem/wasm in browsers, Cloudflare Workers and Deno." },
  { slug: "http", group: "Libraries", title: "packmem/http", description: "Send tables as packed bytes to clients that ask, JSON to the rest." },
  { slug: "react", group: "Libraries", title: "packmem/react", description: "useTable fetches a table into the browser; useRows builds objects only for the rows on screen." },
  { slug: "rust", group: "Libraries", title: "Rust", description: "The core crate: encodings and the packed table." },
  { slug: "nextjs", group: "Guides", title: "Next.js", description: "A server that holds a table and a client page that reads its bytes." },
  { slug: "format", group: "Guides", title: "Byte format", description: "What toBytes and to_bytes write, and which versions read it." },
  { slug: "examples", group: "Guides", title: "Sample projects", description: "Runnable demos in the repository and what each one shows." },
  { slug: "agent-history", group: "Guides", title: "Agent history archive", description: "Keep Claude Code and Codex transcripts, compressed, after the agents delete them." },
  { slug: "agents", group: "Guides", title: "For coding agents", description: "llms.txt, a skill file and a brief to hand to your agent." },
]

export const docHref = (slug: string) => (slug ? `/docs/${slug}/` : "/docs/")
export const docUrl = (slug: string) => `${SITE}${docHref(slug)}`

/** The skill file users drop into their project; the agents page shows it, so it lives in one place. */
export const SKILL_PATH = "skills/packmem/SKILL.md"
export const skillText = () => readFileSync(path.join(ROOT, SKILL_PATH), "utf8")

/** A page's Markdown, with {{VERSION}} and {{SKILL}} filled in. */
export function docSource(slug: string): string {
  const raw = readFileSync(path.join(process.cwd(), "content/docs", `${slug || "index"}.md`), "utf8")
  return raw.replaceAll("{{VERSION}}", VERSION).replace("{{SKILL}}", () => "````markdown\n" + skillText().trim() + "\n````")
}

const LANGS: Record<string, Lang> = {
  py: "python", python: "python",
  js: "typescript", ts: "typescript", javascript: "typescript", typescript: "typescript", mjs: "typescript",
  tsx: "tsx", jsx: "tsx",
  sh: "shellscript", bash: "shellscript", shell: "shellscript", console: "shellscript",
  rust: "rust", rs: "rust", toml: "toml", json: "json", markdown: "markdown", md: "markdown",
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

/** The base path the site is served under, as next.config.ts sets it: for plain links to files that are not pages. */
export const BASE = process.env.NODE_ENV === "production" ? (process.env.PAGES_BASE_PATH ?? "/packmem") : ""

/** Links in the Markdown are written as the site's paths (/docs/node/); the site lives under a base path. */
const withBase = (href: string) => (href.startsWith("/") && !href.startsWith("//") ? `${BASE}${href}` : href)

export type Heading = { id: string; text: string }

/** HTML for a page (code highlighted at build time) and its second-level headings for the page's contents list. */
export async function renderDoc(slug: string): Promise<{ html: string; headings: Heading[]; title: string }> {
  const tokens = marked.lexer(docSource(slug))
  const headings: Heading[] = []
  let title = ""
  const parts: string[] = []
  const renderer = new marked.Renderer()
  renderer.link = function ({ href, title: t, tokens: inner }: Tokens.Link) {
    const text = this.parser.parseInline(inner)
    const ext = /^https?:/.test(href)
    return `<a href="${withBase(href)}"${t ? ` title="${t}"` : ""}${ext ? ' rel="noreferrer"' : ""}>${text}</a>`
  }
  for (const tok of tokens as Token[]) {
    if (tok.type === "code") {
      const lang = LANGS[(tok as Tokens.Code).lang?.split(/\s/)[0] ?? ""] ?? "text"
      parts.push(`<div class="code doc-code">${await highlight((tok as Tokens.Code).text, lang)}</div>`)
      continue
    }
    if (tok.type === "heading") {
      const h = tok as Tokens.Heading
      const text = marked.parseInline(h.text, { renderer }) as string
      if (h.depth === 1) {
        title = h.text
        continue // the layout prints the title
      }
      const id = slugify(h.text)
      if (h.depth === 2) headings.push({ id, text: h.text.replace(/`/g, "") })
      parts.push(`<h${h.depth} id="${id}"><a href="#${id}" class="anchor">${text}</a></h${h.depth}>`)
      continue
    }
    const one = Object.assign([tok], { links: (tokens as unknown as { links: Record<string, unknown> }).links })
    parts.push(marked.parser(one as never, { renderer }))
  }
  return { html: parts.join("\n"), headings, title }
}

/** Every page as Markdown, in sidebar order, for llms-full.txt. */
export function allDocsMarkdown(): string {
  return DOCS.map((p) => `<!-- ${docUrl(p.slug)} -->\n\n${docSource(p.slug).trim()}\n`).join("\n\n")
}
