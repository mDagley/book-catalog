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
  const [tbrItems, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({ select: { id: true, title: true, author: true } }),
    prisma.book.findMany({ select: { title: true } }),
  ]);

  const ownedTitles = books.map((b) => b.title);

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
  // unstable_cache requires an active Next.js request/render context (it
  // looks up an incrementalCache via async storage), which a Vitest unit
  // test running in a plain Node process never has. Rather than calling
  // the cached function and pattern-matching its error message to detect
  // this (brittle across Next.js versions), check NODE_ENV up front —
  // Vitest sets it to "test" automatically — and skip the cache entirely
  // in that case. In any other environment, call the cached function
  // directly with no fallback: a real caching failure should throw loudly
  // (a failed page load) rather than silently degrade into a slow,
  // uncached computation.
  if (process.env.NODE_ENV === "test") {
    return computeTbrGap();
  }
  return getCachedTbrGap();
}
