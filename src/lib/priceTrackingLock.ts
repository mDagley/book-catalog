// In-process mutex shared by the daily cron job (src/instrumentation.ts) and
// the manual "Run price check" route (src/app/api/tbr/run-price-tracking) --
// both run the same heavy match/scrape/digest pipeline against the same
// database. Without this, a manual click while the cron job is mid-run (or
// two manual clicks/tabs racing each other) can overlap two DB-heavy passes
// at once, the same shape of problem that already caused a real production
// incident (Prisma P2028, "Unable to start a transaction in the given
// time") when two sync jobs ran concurrently -- see the noOverlap comment
// in src/instrumentation.ts.
let running = false;

export function tryAcquirePriceTrackingLock(): boolean {
  if (running) return false;
  running = true;
  return true;
}

export function releasePriceTrackingLock(): void {
  running = false;
}
