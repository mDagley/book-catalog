import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const scheduleMock = vi.fn();
const order: string[] = [];

vi.mock("node-cron", () => ({
  default: { schedule: (...args: unknown[]) => scheduleMock(...args) },
  schedule: (...args: unknown[]) => scheduleMock(...args),
}));

// Each mock records its name into a shared `order` array only after
// resolving, and each has a distinct resolve delay -- if the three ever
// ran concurrently instead of sequentially, a longer-delayed earlier call
// could finish after a shorter-delayed later one, and `order` would come
// out of sequence.
vi.mock("@/lib/absSync", () => ({
  syncAbsCache: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 15));
    order.push("abs");
    return { synced: 0 };
  }),
}));
vi.mock("@/lib/goodreadsSync", () => ({
  syncGoodreadsTbr: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("goodreads");
    return { synced: 0 };
  }),
}));
vi.mock("@/lib/ownedPhysicalSync", () => ({
  syncOwnedPhysicalBooks: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push("owned-physical");
    return { synced: 0 };
  }),
}));
vi.mock("@/lib/priceTracking", () => ({
  findRetailerMatches: vi.fn(async () => []),
  scrapePrices: vi.fn(async () => ({})),
  getPriceDrops: vi.fn(async () => []),
}));
vi.mock("@/lib/emailDigest", () => ({
  sendPriceDropDigest: vi.fn(async () => {}),
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  scheduleMock.mockClear();
  order.length = 0;
  process.env.NEXT_RUNTIME = "nodejs";
  process.env.ABS_URL = "https://abs.example.com";
  process.env.ABS_TOKEN = "token";
  process.env.GOODREADS_USER_ID = "1993628";
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

// A single cron job runs all three syncs (ABS, Goodreads, owned-physical)
// sequentially. This used to be two separate cron.schedule() calls on
// offset-but-still-periodic expressions -- an offset only reduces the
// chance the ABS and Goodreads syncs' heavy sequential DB work overlaps, it
// doesn't prevent it (e.g. a slow ABS run could still be in progress when
// the Goodreads job's start time arrives). On the resource-constrained
// production VPS, that overlap starved the DB connection pool badly enough
// to fail a transaction outright with Prisma P2028 ("Unable to start a
// transaction in the given time") -- confirmed in production logs
// 2026-07-16. Merging into one scheduled task makes concurrent execution
// structurally impossible instead of merely unlikely.
//
// A second, separate daily cron job handles TBR retailer price tracking
// (matching, scraping, and the price-drop email digest) -- kept out of the
// 30-minute job so a slow/failing retailer scrape can never delay or block
// the ABS/Goodreads syncs, and vice versa. Its own sync/scrape/digest
// behavior is covered in priceTracking.test.ts and emailDigest.test.ts, so
// this file only verifies the job is registered with the right schedule.
describe("register", () => {
  it("registers exactly two cron jobs: the 30-minute sync job and the daily price-tracking job", async () => {
    const { register } = await import("@/instrumentation");
    await register();

    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock.mock.calls[0][0]).toBe("*/30 * * * *");
    expect(scheduleMock.mock.calls[1][0]).toBe("0 6 * * *");
  });

  it("runs the ABS, Goodreads, and owned-physical syncs sequentially, never concurrently", async () => {
    const { register } = await import("@/instrumentation");
    await register();

    const [, callback] = scheduleMock.mock.calls[0];
    await callback();

    // Despite owned-physical resolving fastest and ABS resolving slowest
    // when run in isolation, sequential awaiting means they still complete
    // in call order -- abs, then goodreads, then owned-physical.
    expect(order).toEqual(["abs", "goodreads", "owned-physical"]);
  });
});
