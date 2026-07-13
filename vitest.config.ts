import "dotenv/config";
import { defineConfig, defaultExclude } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Extend (not replace) Vitest's own defaults — .next/ isn't covered by
    // them, and next build's standalone output copies the whole traced
    // source tree (including *.test.ts files) under .next/standalone.
    // Without this, running tests after a build picks up those stray
    // copies too, racing duplicate test runs against the same real dev
    // database.
    exclude: [...defaultExclude, "**/.next/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
