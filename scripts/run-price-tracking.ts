// Runs one full pass of TBR price tracking on demand: match unowned TBR
// items to retailer listings, scrape/fetch prices for confirmed matches,
// then send the drop digest email if any drops were found. Identical to
// what the daily cron job in src/instrumentation.ts does -- this just lets
// you trigger that same pass immediately instead of waiting for 06:00.
//
// >>> This does NOT run inside the deployed container. <<<
// Same reasoning as scripts/backfill-tbr-owned.ts: it needs tsx to resolve
// the `@/` path alias, and tsx is a devDependency pruned from the
// production image.
//
// Run from a dev machine with full node_modules installed, pointed at
// production's DATABASE_URL (and optionally RESEND_API_KEY/
// PRICE_ALERT_EMAIL/GOOGLE_BOOKS_API_KEY, read the same way the deployed
// app reads them):
//
//   DATABASE_URL="postgresql://..." npm run price-tracking:run
//
// Not invoked automatically by any application code, sync, or test.
import { findRetailerMatches, scrapePrices, getPriceDrops } from "@/lib/priceTracking";
import { sendPriceDropDigest } from "@/lib/emailDigest";
import { prisma } from "@/lib/prisma";

async function main() {
  console.log("Matching TBR items to retailers...");
  await findRetailerMatches();

  console.log("Scraping prices for confirmed matches...");
  await scrapePrices();

  const drops = await getPriceDrops();
  console.log(`Found ${drops.length} price drop(s).`);
  await sendPriceDropDigest(drops);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
