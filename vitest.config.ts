import { config as loadEnv, parse as parseEnv } from "dotenv";
import { defineConfig, defaultExclude } from "vitest/config";
import fs from "fs";
import path from "path";

// Tests must run against an isolated database, never the shared dev DB that
// `next dev`/`.env` points at. Several sync functions (fetchMissingTbrCovers,
// backfillAbsCovers, and historically an unscoped goodreadsTbrItem
// deleteMany) run unscoped queries/writes across an entire table -- once
// real synced data exists in a shared DB, running the test suite there can
// permanently corrupt or destroy it (this already happened once, wiping real
// GoodreadsTbrItem rows during Phase 4). Fail loudly if .env.test is
// missing, or if it resolves to the same DATABASE_URL as .env, rather than
// silently falling back to the shared dev database.
const envTestPath = path.resolve(__dirname, ".env.test");
if (!fs.existsSync(envTestPath)) {
  throw new Error(
    "Missing .env.test -- tests must run against an isolated database, not the shared dev DB.\n" +
      "Create a dedicated Postgres database (e.g. `bookcatalog_test`), copy .env to .env.test, " +
      "and point its DATABASE_URL at that database, then run `npx prisma migrate deploy` against it.",
  );
}
// dotenv's config() does NOT override a variable that's already present in
// process.env (e.g. inherited from a parent shell that sourced .env, or set
// by CI) -- confirmed empirically. Without `override: true`, a pre-set
// DATABASE_URL would silently defeat this whole isolation mechanism: the
// test run would keep using whatever was already in the environment instead
// of .env.test's value, while the guard below (if it compared process.env
// after loading) could pass or fail based on that same stale value rather
// than what .env.test actually specifies.
const parsedTestEnv = parseEnv(fs.readFileSync(envTestPath));
loadEnv({ path: envTestPath, override: true });

const devEnvPath = path.resolve(__dirname, ".env");
if (fs.existsSync(devEnvPath)) {
  // Compare the two files' parsed values directly, not process.env -- this
  // stays correct regardless of what else may have set process.env.DATABASE_URL
  // before this file ran.
  const parsedDevEnv = parseEnv(fs.readFileSync(devEnvPath));
  if (parsedDevEnv.DATABASE_URL && parsedDevEnv.DATABASE_URL === parsedTestEnv.DATABASE_URL) {
    throw new Error(
      ".env.test's DATABASE_URL is identical to .env's -- tests would run against the shared " +
        "dev database. Point .env.test at a dedicated test database instead.",
    );
  }
}

export default defineConfig({
  test: {
    environment: "node",
    // Extend (not replace) Vitest's own defaults — .next/ isn't covered by
    // them, and next build's standalone output copies the whole traced
    // source tree (including *.test.ts files) under .next/standalone.
    // Without this, running tests after a build picks up those stray
    // copies too, racing duplicate test runs against the same isolated
    // test database.
    exclude: [...defaultExclude, "**/.next/**"],
    // Several tests across different files use overlapping fixture
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
