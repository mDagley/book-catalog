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
    // These tests hit a real, shared dev Postgres instance rather than a
    // mock — several tests across different files use overlapping fixture
    // titles/tables (e.g. full-table deleteMany() setup calls), so running
    // test files in parallel causes real, reproducible cross-file races
    // (confirmed: a Book row deleted by one file's concurrent test while
    // another file's test was still using it). Serial file execution trades
    // some speed for actually-reliable test results.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
