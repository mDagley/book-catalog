import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
}

/** Tag used to invalidate the cached TBR gap computation after a sync completes. */
export const TBR_GAP_CACHE_TAG = "tbr-gap";

async function computeTbrGap(): Promise<TbrGapItem[]> {
  const [tbrItems, books, absItems] = await Promise.all([
    prisma.goodreadsTbrItem.findMany(),
    prisma.book.findMany({ select: { title: true } }),
    prisma.absCacheItem.findMany({ select: { title: true } }),
  ]);

  const ownedTitles = [...books.map((b) => b.title), ...absItems.map((a) => a.title)];

  return tbrItems
    .filter((tbr) => !ownedTitles.some((owned) => isTitleMatch(tbr.title, owned)))
    .map((tbr) => ({ id: tbr.id, title: tbr.title, author: tbr.author }));
}

// Cache the expensive fuzzy-matching computation rather than re-running it on
// every page load. Revalidated on-demand via revalidateTag(TBR_GAP_CACHE_TAG)
// when a manual sync completes via the /api/sync/* route handlers. The
// scheduled cron syncs in src/instrumentation.ts do NOT call revalidateTag —
// revalidateTag requires an active Next.js request/action context and throws
// when called from a node-cron callback, which runs outside any such context
// — so this 30-minute revalidate window is not just a rare safety net, it's
// the only invalidation path for cron-triggered syncs. Up to ~30 minutes of
// staleness after an automatic sync is expected and accepted, matching the
// cron interval itself; only the manual "Refresh now" path gets immediate
// freshness.
const getCachedTbrGap = unstable_cache(computeTbrGap, ["tbr-gap"], {
  tags: [TBR_GAP_CACHE_TAG],
  revalidate: 1800,
});

export async function getTbrGap(): Promise<TbrGapItem[]> {
  // unstable_cache requires an active Next.js request/render context: it
  // looks up an incrementalCache via async storage (or a globalThis
  // fallback) and throws an "incrementalCache missing" invariant error if
  // neither is present. That's the case when this function is called
  // directly from a Vitest unit test in a plain Node process (no Next.js
  // server involved). Fall back to computing directly in that situation
  // rather than letting the error propagate, so getTbrGap's public contract
  // (identical behavior for any caller) holds regardless of context.
  try {
    return await getCachedTbrGap();
  } catch (error) {
    if (error instanceof Error && error.message.includes("incrementalCache missing")) {
      console.warn(
        "getTbrGap: unstable_cache unavailable outside a Next.js request context (expected in tests); falling back to an uncached computation.",
      );
      return computeTbrGap();
    }
    throw error;
  }
}
