import { prisma } from "@/lib/prisma";
import { librofmAdapter } from "@/lib/retailers/librofm";
import { googleplayAdapter } from "@/lib/retailers/googleplay";
import type { RetailerAdapter } from "@/lib/retailers/types";

const ADAPTERS: RetailerAdapter[] = [librofmAdapter, googleplayAdapter];

export async function findRetailerMatches(): Promise<void> {
  const items = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true, author: true, retailerMatches: { select: { retailer: true } } },
  });

  for (const item of items) {
    const existingRetailers = new Set(item.retailerMatches.map((m) => m.retailer));
    for (const adapter of ADAPTERS) {
      if (existingRetailers.has(adapter.id)) continue;

      try {
        const result = await adapter.search(item.title, item.author);
        if (!result) continue;
        await prisma.retailerMatch.create({
          data: {
            tbrItemId: item.id,
            retailer: adapter.id,
            productUrl: result.productUrl,
            matchedTitle: result.matchedTitle,
            matchedAuthor: result.matchedAuthor,
          },
        });
      } catch (err) {
        console.error(`Retailer match failed for "${item.title}" on ${adapter.id}:`, err);
      }
    }
  }
}

export async function scrapePrices(): Promise<void> {
  const matches = await prisma.retailerMatch.findMany({
    where: { confirmed: true },
    select: { id: true, retailer: true, productUrl: true },
  });
  const adaptersById = new Map<string, RetailerAdapter>(ADAPTERS.map((a) => [a.id, a]));

  for (const match of matches) {
    const adapter = adaptersById.get(match.retailer);
    if (!adapter) {
      // Should never happen in practice -- `retailer` is only ever written
      // from a RetailerAdapter.id -- but a stray/corrupt value would
      // otherwise silently stop this match from scraping forever with no
      // signal anywhere that it's happening.
      console.error(`No adapter registered for retailer "${match.retailer}" (match ${match.id})`);
      continue;
    }

    try {
      const price = await adapter.fetchPrice(match.productUrl);
      if (price === null) continue;
      await prisma.priceObservation.create({ data: { retailerMatchId: match.id, price } });
    } catch (err) {
      console.error(`Price scrape failed for match ${match.id} (${match.retailer}):`, err);
    }
  }
}

export interface PriceDrop {
  tbrItemId: string;
  tbrItemTitle: string;
  retailer: string;
  previousPrice: number;
  newPrice: number;
}

export async function getPriceDrops(): Promise<PriceDrop[]> {
  const matches = await prisma.retailerMatch.findMany({
    where: { confirmed: true },
    include: {
      tbrItem: { select: { id: true, title: true } },
      observations: { orderBy: { observedAt: "desc" }, take: 2, select: { price: true } },
    },
  });

  const drops: PriceDrop[] = [];
  for (const match of matches) {
    if (match.observations.length < 2) continue;
    const [newest, previous] = match.observations;
    if (newest.price < previous.price) {
      drops.push({
        tbrItemId: match.tbrItem.id,
        tbrItemTitle: match.tbrItem.title,
        retailer: match.retailer,
        previousPrice: previous.price,
        newPrice: newest.price,
      });
    }
  }
  return drops;
}
