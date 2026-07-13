import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Vitest's default excludes don't cover .next/ — next build's standalone
    // output copies the whole traced source tree (including *.test.ts files)
    // under .next/standalone, and without this, running tests after a build
    // picks up those stray copies too, racing duplicate test runs against
    // the same real dev database.
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
