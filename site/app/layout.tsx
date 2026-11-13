import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import * as d from "@/lib/data"

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })

const title = "packmem: records in a fraction of the memory"
const description =
  "Keep records as packed columns your code can still index, loop over, update and query, without unpacking anything. Python, Node and Rust."

const image = {
  url: "og.png",
  width: 1200,
  height: 630,
  alt: `packmem: 336,776 flight records take ${Math.round(d.hero.a)} MB as a Python list of dicts and ${d.hero.b.toFixed(1)} MB in packmem.`,
}

export const metadata: Metadata = {
  metadataBase: new URL("https://hamedmp.github.io/packmem/"),
  title,
  description,
  openGraph: { title, description, url: "./", siteName: "packmem", type: "website", images: [image] },
  twitter: { card: "summary_large_image", title, description, images: [image] },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)}>
      <body>
        <ThemeProvider defaultTheme="dark">
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
