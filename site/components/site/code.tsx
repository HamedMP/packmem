import { highlight, type Lang } from "@/lib/highlight"

/** A highlighted code block, with an optional shell line above it. Rendered at build time. */
export async function Code({ install, lang, children }: { install?: string; lang: Lang; children: string }) {
  const [cmd, code] = await Promise.all([install ? highlight(install, "shellscript") : null, highlight(children, lang)])
  return (
    <div className="code overflow-hidden rounded-lg border bg-muted/60 font-mono text-[13px] leading-relaxed backdrop-blur-sm">
      {cmd && (
        <div className="flex gap-2 overflow-x-auto border-b px-4 py-2.5">
          <span aria-hidden className="text-muted-foreground select-none">$</span>
          <div dangerouslySetInnerHTML={{ __html: cmd }} />
        </div>
      )}
      <div className="overflow-x-auto p-4" dangerouslySetInnerHTML={{ __html: code }} />
    </div>
  )
}
