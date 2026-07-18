import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
  coverImagePath: string | null;
}

/** Tag used to invalidate the cached TBR gap computation after a sync completes. */
export const TBR_GAP_CACHE_TAG = "tbr-gap";

// Author (trimmed) if present, else title (trimmed) -- used both to sort the
// full list and to decide which letter bucket an item falls into in
// groupByInitial, so the two always agree on what "browsing alphabetically"
// means for a given item.
function sortKey(item: Pick<TbrGapItem, "title" | "author">): string {
  return item.author?.trim() || item.title.trim();
}

// Strips diacritics before the A-Z test so bucketing agrees with sortKey's
// locale-aware, base-letter-insensitive sort (an author like "Émile Zola"
// sorts among the E's -- it should bucket under "E", not fall through to
// "#" just because its first character isn't plain ASCII).
function letterBucket(key: string): string {
  const normalized = key
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase();
  const firstChar = normalized.charAt(0);
  return /[A-Z]/.test(firstChar) ? firstChar : "#";
}

async function computeTbrGap(): Promise<TbrGapItem[]> {
  const [tbrItems, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({
      select: { id: true, title: true, author: true, coverImagePath: true },
    }),
    prisma.book.findMany({ select: { title: true } }),
  ]);

  const ownedTitles = books.map((b) => b.title);

  return tbrItems
    .filter((tbr) => !ownedTitles.some((owned) => isTitleMatch(tbr.title, owned)))
    .map((tbr) => ({
      id: tbr.id,
      title: tbr.title,
      author: tbr.author,
      coverImagePath: tbr.coverImagePath,
    }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: "base" }));
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

// `query` is applied in-memory, after the cache lookup, against the full
// (already sorted) gap list -- filtering ~800 items in-process is cheap, and
// keeping the cache keyed only on the unfiltered gap avoids a per-query cache
// entry for what would otherwise be an unbounded set of possible query
// strings.
export async function getTbrGap(query?: string): Promise<TbrGapItem[]> {
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
  const gap = process.env.NODE_ENV === "test" ? await computeTbrGap() : await getCachedTbrGap();

  const trimmed = query?.trim().toLowerCase();
  if (!trimmed) return gap;
  return gap.filter(
    (item) =>
      item.title.toLowerCase().includes(trimmed) ||
      (item.author?.toLowerCase().includes(trimmed) ?? false),
  );
}

export interface TbrGapGroup {
  letter: string;
  items: TbrGapItem[];
}

// Assumes `items` is already sorted by the same sortKey used here (true for
// whatever getTbrGap returns) -- this only groups, it doesn't re-sort, so
// each group's items stay in the order they arrived in.
export function groupByInitial(items: TbrGapItem[]): TbrGapGroup[] {
  const groups = new Map<string, TbrGapItem[]>();
  for (const item of items) {
    const letter = letterBucket(sortKey(item));
    const group = groups.get(letter);
    if (group) {
      group.push(item);
    } else {
      groups.set(letter, [item]);
    }
  }

  const letters = [...groups.keys()].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  return letters.map((letter) => ({ letter, items: groups.get(letter)! }));
}
