import type { Metadata } from "next"

import { DocPage } from "@/components/site/doc-page"
import { DOCS } from "@/lib/docs"

export const metadata: Metadata = {
  title: "Docs · packmem",
  description: DOCS[0].description,
}

export default function DocsHome() {
  return <DocPage slug="" />
}
