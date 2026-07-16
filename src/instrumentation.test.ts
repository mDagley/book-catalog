import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const scheduleMock = vi.fn();

vi.mock("node-cron", () => ({
  default: { schedule: (...args: unknown[]) => scheduleMock(...args) },
  schedule: (...args: unknown[]) => scheduleMock(...args),
}));

vi.mock("@/lib/absSync", () => ({ syncAbsCache: vi.fn() }));
vi.mock("@/lib/goodreadsSync", () => ({ syncGoodreadsTbr: vi.fn() }));

const originalRuntime = process.env.NEXT_RUNTIME;

beforeEach(() => {
  scheduleMock.mockClear();
  process.env.NEXT_RUNTIME = "nodejs";
});

afterEach(() => {
  process.env.NEXT_RUNTIME = originalRuntime;
  vi.resetModules();
});

// Both cron jobs used to share the identical "*/30 * * * *" expression,
// so syncAbsCache and syncGoodreadsTbr fired at the exact same instant every
// 30 minutes -- on the resource-constrained production VPS this caused
// syncGoodreadsTbr's $transaction to fail with Prisma P2028 ("Unable to
// start a transaction in the given time") while syncAbsCache's own heavy
// sequential DB work held the connection pool busy. Confirmed in production
// logs 2026-07-16 (both the 30-min cron and manual "Refresh now" surfaced
// this). The two schedules must never resolve to the same wall-clock minute.
describe("register", () => {
  it("schedules the ABS and Goodreads syncs on different cron expressions", async () => {
    const { register } = await import("@/instrumentation");
    await register();

    expect(scheduleMock).toHaveBeenCalledTimes(2);
    const [absExpr] = scheduleMock.mock.calls[0];
    const [goodreadsExpr] = scheduleMock.mock.calls[1];
    expect(absExpr).not.toBe(goodreadsExpr);
  });
});
