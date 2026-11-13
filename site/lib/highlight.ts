// Syntax highlighting at build time: the page ships coloured HTML and no highlighter.
import "server-only"
import { createHighlighter } from "shiki"

export type Lang = "python" | "typescript" | "rust" | "shellscript"

const THEMES = { light: "vitesse-light", dark: "vitesse-dark" } as const
const highlighter = createHighlighter({
  themes: Object.values(THEMES),
  langs: ["python", "typescript", "rust", "shellscript"],
})

/** Tokens carry both themes as CSS variables; globals.css picks one from the page's theme. */
export async function highlight(code: string, lang: Lang) {
  return (await highlighter).codeToHtml(code.trim(), { lang, themes: THEMES, defaultColor: false })
}
