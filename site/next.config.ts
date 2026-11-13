import type { NextConfig } from "next"

// GitHub Pages serves the project site from /packmem; local development runs at the root.
const basePath = process.env.NODE_ENV === "production" ? (process.env.PAGES_BASE_PATH ?? "/packmem") : ""

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
}

export default nextConfig
