import { NextResponse } from "next/server";
import { findRetailerMatches, scrapePrices, getPriceDrops } from "@/lib/priceTracking";
import { sendPriceDropDigest } from "@/lib/emailDigest";
import { tryAcquirePriceTrackingLock, releasePriceTrackingLock } from "@/lib/priceTrackingLock";

// Manual "Run price check" trigger for /tbr -- runs the exact same three
// steps as the daily cron job in src/instrumentation.ts (and
// scripts/run-price-tracking.ts), on demand. Deliberately slow (a network
// call per unconfirmed TBR item across two retailers) and deliberately
// user-triggered, same tradeoff as the existing recompute-ownership route.
//
// Guarded by the same lock the cron job uses (priceTrackingLock.ts) -- a
// manual click while the cron job (or another manual click) is mid-run
// would otherwise overlap two DB-heavy passes, the same shape of problem
// that already caused a production P2028 incident (see instrumentation.ts).
export async function POST() {
  if (!tryAcquirePriceTrackingLock()) {
    return NextResponse.json(
      { success: false, error: "A price-tracking run is already in progress." },
      { status: 409 },
    );
  }

  try {
    await findRetailerMatches();
    await scrapePrices();
    const drops = await getPriceDrops();
    await sendPriceDropDigest(drops);
    return NextResponse.json({ success: true, dropCount: drops.length });
  } catch (error) {
    console.error("Manual price-tracking run failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Price tracking run failed",
      },
      { status: 500 },
    );
  } finally {
    releasePriceTrackingLock();
  }
}
