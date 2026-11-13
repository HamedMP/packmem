# packmem site

The project page at https://hamedmp.github.io/packmem/: a Next.js app exported as static files, built with
shadcn/ui. Every figure on it is read from the results files in this repository at build time
(`lib/data.ts`), so re-running a benchmark and rebuilding updates the page.

    pnpm install
    pnpm dev        # http://localhost:3000
    pnpm build      # static export in out/, served under /packmem (PAGES_BASE_PATH overrides)

Press `d` to switch between the light and dark themes.
