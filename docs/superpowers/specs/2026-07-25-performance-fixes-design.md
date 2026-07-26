# Performance Fixes: TBR Gap & Books Listing — Design Spec

## Goal

Fix two independent, empirically-confirmed performance problems reported by the user ("Why does navigating to the manage all books and tbr gap pages take so long?"):

1. `/tbr` can take **~50 seconds** to load on a cold cache.
2. `/books` takes **~2.3–2.9 seconds** to load at realistic library scale (~1800 rows), regardless of cache state.

These are unrelated mechanisms in unrelated code paths — the fixes below are independent of each other and could be implemented/planned as two separate efforts.

## Background

### `/tbr`

`computeTbrGap()` (`src/lib/tbrGap.ts`) determines which Goodreads TBR items you don't already own by comparing every TBR item's title against every owned `Book` title with fuzzy matching (`isTitleMatch`, from `src/lib/matching.ts`):

```ts
tbrItems.filter((tbr) => !ownedTitles.some((owned) => isTitleMatch(tbr.title, owned)))
```

Measured directly against a realistic-scale seeded dataset (900 owned books × 808 TBR items, matching this library's real Goodreads TBR count): **49,267ms** for the computation alone, **51.2 seconds** for a full cold-cache `/tbr` page load.

The result is wrapped in `unstable_cache` with a 30-minute `revalidate`, tagged `TBR_GAP_CACHE_TAG`. Both `src/app/api/sync/abs/route.ts` and `src/app/api/sync/goodreads/route.ts` call `revalidateTag(TBR_GAP_CACHE_TAG, { expire: 0 })` after a sync — confirmed, via this project's bundled Next.js 16.2.10 docs, that this specific form causes **immediate, blocking** cache expiration (not stale-while-revalidate). So the very next `/tbr` visit after clicking "Refresh now" pays the full ~50-second cost synchronously — a completely natural, common workflow.

**Why the established "cheap-exact-tier + capped-fuzzy-fallback" fix (already used in `reconcileTbrItems` and `findDuplicateBookGroups`) doesn't transfer here:** in those two functions, most items being compared are *unchanged repeats* of something already in the table, so an exact-match tier catches the overwhelming majority and only a handful need the fuzzy fallback — capping that handful is safe. In `computeTbrGap`, a TBR item is by definition a book you haven't acquired yet, so its title essentially never exactly matches an owned title — the fuzzy check IS the interesting case for nearly every item. Capping it would silently stop checking most of the list, misclassifying owned books (under a differently-formatted title) as still-need-to-read.

The deeper root cause: `computeTbrGap` recomputes the **entire** cross-product from scratch on every cache miss, even though ownership data is mostly static and changes only in small increments (a sync adds a few new TBR items; a book gets added/edited/deleted). There's no reason to redo the whole comparison every time instead of maintaining it incrementally.

### `/books`

`searchCatalog({ browseAll: true, sortBy: "title" })` (`src/lib/search.ts`) does a plain Prisma `findMany` — measured at **74ms** even at ~1800 rows, not the bottleneck. Its filters (`types`, `format`, `status`) are already expressed as `WHERE` clauses against real DB columns (`hasEbook`, `hasAudiobook`, `readStatus`, `rating`, physical-copy `format`) — nothing is computed in application code per fetch.

The actual cost is `src/app/books/page.tsx` rendering **every** result row into one HTML response with no pagination or `LIMIT` — measured at 2.3–2.9 seconds server response time and a 4.3MB HTML payload at ~1800-book scale (dev mode; production likely somewhat faster but not dramatically).

## Design: `/tbr` — persisted, incrementally-maintained ownership flag

### Schema

Add one column to `GoodreadsTbrItem`:

```prisma
model GoodreadsTbrItem {
  // ...existing fields...
  owned Boolean @default(false)
}
```

### Two new shared functions (`src/lib/tbrGap.ts`)

```ts
// Call whenever a new owned title starts existing (a Book is created, or an
// existing Book's title changes to something new). Checks only currently-
// unowned TBR items against this one title -- O(unowned TBR items), not the
// full owned-books cross product -- and flips any fuzzy match to owned.
export async function markTbrItemsOwnedByTitle(title: string): Promise<void> {
  const unowned = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true },
  });
  const nowOwnedIds = unowned
    .filter((item) => isTitleMatch(item.title, title))
    .map((item) => item.id);
  if (nowOwnedIds.length === 0) return;
  await prisma.goodreadsTbrItem.updateMany({
    where: { id: { in: nowOwnedIds } },
    data: { owned: true },
  });
}

// Call whenever an owned title stops existing (a Book is deleted, or an
// existing Book's title changes away from its old value). Re-verifies only
// currently-owned TBR items against the full current owned-title list --
// bounded by how many TBR items have ever matched an owned book, not the
// full TBR list -- and flips any that no longer match back to unowned.
export async function recheckOwnedTbrItems(): Promise<void> {
  const [owned, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({
      where: { owned: true },
      select: { id: true, title: true },
    }),
    prisma.book.findMany({ select: { title: true } }),
  ]);
  if (owned.length === 0) return;
  const ownedTitles = books.map((b) => b.title);
  const noLongerOwnedIds = owned
    .filter((item) => !ownedTitles.some((title) => isTitleMatch(item.title, title)))
    .map((item) => item.id);
  if (noLongerOwnedIds.length === 0) return;
  await prisma.goodreadsTbrItem.updateMany({
    where: { id: { in: noLongerOwnedIds } },
    data: { owned: false },
  });
}
```

Both reuse the existing `isTitleMatch` from `src/lib/matching.ts` — same matching semantics as today, just invoked at a completely different (much smaller) scale and cadence.

### Call sites (7 total)

Every call below runs **after** its corresponding Prisma write has committed, never before. This matters most for `recheckOwnedTbrItems()`, which reads the live `Book` table to decide what's still owned — called before a delete/title-change commits, it would still see the old/soon-to-be-gone title as owned and fail to flip anything.

| File | Function | Event | Call |
|---|---|---|---|
| `src/lib/books.ts` | scan/add-flow book creation | new Book, new title | `markTbrItemsOwnedByTitle(title)` |
| `src/lib/books.ts` | `updateBookData` (edit page) | title changed | fetch old title *before* the update (needed to detect a change at all); after the update commits, if `oldTitle !== newTitle`: `recheckOwnedTbrItems()` then `markTbrItemsOwnedByTitle(newTitle)` |
| `src/lib/absSync.ts` | `createBookForItem` | new Book, new title | `markTbrItemsOwnedByTitle(title)` |
| `src/lib/absSync.ts` | `removeStaleAbsLinks` | Book deleted (zero copies left) | `recheckOwnedTbrItems()` |
| `src/lib/ownedPhysicalSync.ts` | owned-physical sync creation | new Book, new title | `markTbrItemsOwnedByTitle(title)` |
| `src/lib/duplicates.ts` | merge (losing books deleted) | Book(s) deleted | `recheckOwnedTbrItems()` |
| `src/lib/copies.ts` | `deleteCopyData` (last copy removed) | Book deleted | `recheckOwnedTbrItems()` |

`updateBookData` is the only site needing the old title first — it must fetch the current title before overwriting it, to detect whether a title change actually happened (avoids running the recheck/mark pair on every edit-page save, most of which don't touch title at all).

Not included: `absSync.ts`'s `linkItemToExistingBook` (never writes title — explicit in its own comment) and `goodreadsSync.ts`'s `applyShelfToBooks` (only writes `readStatus`/`rating`, never title) — neither can change which titles are owned.

### `reconcileTbrItems` (Goodreads TBR sync itself)

Currently doesn't query `Book` at all. Add one `prisma.book.findMany({ select: { title: true } })` up front (cheap, one query), and compute `owned` directly for the two cases that need it:

- **New shelf item** (`toCreate`): `owned: ownedTitles.some((t) => isTitleMatch(shelfItem.title, t))`, computed once per new item.
- **Existing item whose title changed** (already-detected branch that calls `prisma.goodreadsTbrItem.update`): recompute `owned` the same way and include it in the update payload.

Unchanged items are left alone — their `owned` value only needs to change when their own title changes (handled here) or when the owned-book set changes (handled by the call sites above, independent of any sync running).

### `computeTbrGap` simplification

```ts
async function computeTbrGap(): Promise<TbrGapItem[]> {
  const tbrItems = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true, author: true, coverImagePath: true, isbn: true },
  });
  return tbrItems
    .map((tbr) => ({ id: tbr.id, title: tbr.title, author: tbr.author, coverImagePath: tbr.coverImagePath, isbn: tbr.isbn }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: "base" }));
}
```

No fuzzy matching, no cross-product, at read time — ever.

### Drop entirely

- `unstable_cache` wrapper (`getCachedTbrGap`) and the `NODE_ENV === "test"` branch in `getTbrGap` that exists solely to work around it in Vitest.
- `TBR_GAP_CACHE_TAG` export.
- `revalidateTag(TBR_GAP_CACHE_TAG, { expire: 0 })` calls in `src/app/api/sync/abs/route.ts` and `src/app/api/sync/goodreads/route.ts` — those routes go back to just running their sync(s) and returning success/error.

This also fixes a latent gap for free: cron-triggered syncs (`src/instrumentation.ts`) never called `revalidateTag` (no request context available from a `node-cron` callback), so they relied on the 30-minute TTL for eventual freshness. Under this design the `owned` flag is updated directly inside the sync functions themselves — cron-triggered syncs get immediately-correct `/tbr` results too, with no caching involved anywhere.

### One-time backfill

A Prisma migration adds the `owned` column (defaulting `false`), then a companion one-time data step — raw SQL plus a small TypeScript function, matching the confirmed precedent in `prisma/migrations/20260716192026_unify_copy_types/migration.sql` — computes the correct initial `owned` value for every existing `GoodreadsTbrItem` against the current `Book` table. This is the only place the original O(n×m) cost still runs, once, at deploy time, not per-request.

## Design: `/books` — pagination

### `searchCatalog` / `SearchOptions`

Add an optional field:

```ts
export interface SearchOptions {
  // ...existing fields...
  limit?: number;
}
```

Applied as Prisma's `take: options.limit` when present; omitted entirely (current unlimited behavior) when not. The only other production caller, `src/app/page.tsx` (home page search), never passes it — unaffected.

### `/books/page.tsx`

- Read a `limit` search param, default `50` when absent/invalid.
- Call `searchCatalog({ ...filters, limit: limit + 1 })` — fetching one extra row is a cheap way to detect "more results exist" without a separate `count()` query.
- Render only the first `limit` results; if the `limit + 1`th came back, show a "Load more" link to the same page with `limit` increased by 50, preserving every existing param (`q`, `types`, `format`, `status`, `statusMode`).

This is a full-page-reload "load more" (a link with a bigger `limit`, not a client-side incremental fetch-and-append) — simplest implementation, consistent with this page's current all-server-component architecture, no new API route or client state needed. Trade-off: clicking "Load more" resets scroll position to the top; judged acceptable for a personal-library management page.

## Non-goals

- No change to the fuzzy-matching algorithm itself (`isTitleMatch`/`titleMatchScore`/`titleForms` in `matching.ts`) — untouched, still used, just invoked far less often and at far smaller scale.
- No incremental/client-side "Load more" (no new API route, no client component) for `/books` — a full reload with a bigger `limit` is sufficient.
- No pagination for `/tbr` — its list is now a cheap indexed query regardless of size; no rendering-cost problem was found there (the `/tbr` cost was 100% the fuzzy-matching computation, not the render).
- No change to `reconcileTbrItems`'s own existing `FUZZY_FALLBACK_CAP` mechanism (matching *existing* TBR rows against each other during sync) — untouched, unrelated to the new owned-title matching added here.

## Testing

**TBR ownership tracking:**
- `markTbrItemsOwnedByTitle`: a currently-unowned TBR item whose title fuzzy-matches the given title flips to `owned: true`; an already-owned item is untouched (not re-checked); a TBR item that doesn't match is untouched.
- `recheckOwnedTbrItems`: a currently-owned TBR item that no longer matches any current owned title flips to `owned: false`; one that still matches (a different owned book) stays `owned: true`; unowned items are never queried/touched.
- `reconcileTbrItems`: a newly-created shelf item gets the correct initial `owned` value based on current owned books; an existing item whose title changes gets `owned` recomputed; an unchanged item's `owned` value is left alone.
- Each of the 7 call sites: a real create/edit/delete through the actual function (not a mock) followed by a real query confirming the expected TBR item(s) flipped state — matching this project's established "seed real rows, query for real, assert on real output" convention.
- `computeTbrGap`: returns exactly the `owned: false` rows, correctly sorted; confirms no fuzzy-matching code path is reachable from it anymore (i.e., it can't regress back into recomputing).
- Backfill: given a mix of existing `Book`/`GoodreadsTbrItem` rows (some matching, some not), the migration's data step sets `owned` correctly for every existing row.

**Books pagination:**
- `searchCatalog` with `limit` set returns at most `limit` rows; omitted `limit` returns everything (regression check against every existing unlimited-result test).
- `/books/page.tsx`: fewer than `limit` results → no "Load more" link; exactly `limit + 1`+ available → link present and its `href` carries over every active filter/search param plus the increased `limit`.
