import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces .next/standalone: a self-contained server bundle (traced
  // files + a pruned node_modules) used as the base for the Docker image.
  // The Dockerfile's runner stage later replaces this pruned node_modules
  // with the production-only dependency tree from its prod-deps stage
  // (needed to run the Prisma CLI at startup, which Next's tracing never
  // sees), so the final image isn't as minimal as this output alone — see
  // Dockerfile for why.
  output: "standalone",
};

export default nextConfig;
