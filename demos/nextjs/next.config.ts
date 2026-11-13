import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // packmem loads a native addon, so it is required at runtime instead of bundled
  serverExternalPackages: ["packmem", "pg", "pg-cursor"],
};

export default nextConfig;
