import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone: a minimal, self-contained server bundle
  // (only traced files + a pruned node_modules) for the Docker image.
  output: "standalone",
};

export default nextConfig;
