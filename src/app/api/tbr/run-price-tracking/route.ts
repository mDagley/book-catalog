import { NextResponse } from "next/server";
import { findRetailerMatches, scrapePrices, getPriceDrops } from "@/lib/priceTracking";
import { sendPriceDropDigest } from "@/lib/emailDigest";

// Manual "Run price check" trigger for /tbr -- runs the exact same three
// steps as the daily cron job in src/instrumentation.ts (and
// scripts/run-price-tracking.ts), on demand. Deliberately slow (a network
// call per unconfirmed TBR item across two retailers) and deliberately
// user-triggered, same tradeoff as the existing recompute-ownership route.
export async function POST() {
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
  }
}
