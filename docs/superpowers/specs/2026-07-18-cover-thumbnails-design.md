# Cover Thumbnails in Listings — Design

## Overview

Book covers currently only appear on the book detail page. Most books now have a cover thanks to the PR #18 cover-images phase (physical copies get one from the scan flow; ebook/audiobook copies can have one set manually), so this phase surfaces them in the list views too: the home page's unified search results, `/books` (Manage Physical Books), and `/tbr` (TBR gap view).

`/tbr` is a special case: TBR items aren't owned yet, so there's no existing cover data to surface — this phase adds an Open Library-backed cover-fetch pipeline for them, which in turn requires reworking how `syncGoodreadsTbr` persists TBR rows (see Section 2). Along the way, a related gap surfaced: existing ebook/audiobook copies that were linked before PR #18 (or never had a cover manually set) already have real cover art sitting in the user's Audiobookshelf server, reachable via its REST API — Section 3 backfills those too.

## Section 1: Cover resolution (data layer)

A new pure helper, `resolveListingCover`, in a new file `src/lib/listingCover.ts`:

```ts
interface CoverSource {
  coverImagePath: string | null;
}

interface CoverableBook {
  copies: CoverSource[];
  ebookCopies: CoverSource[];
  audiobookCopies: CoverSource[];
}

export function resolveListingCover(book: CoverableBook): string | null {
  for (const list of [book.copies, book.ebookCopies, book.audiobookCopies]) {
    const found = list.find((c) => c.coverImagePath !== null);
    if (found) return found.coverImagePath;
  }
  return null;
}
```

Priority: physical copies first (in array order), then ebook copies, then audiobook copies. This applies regardless of any active ownership-type filter on the home page — the thumbnail always represents "this book," not "this book within the currently filtered view."

- `searchCatalog` (`src/lib/search.ts`): extended to also fetch `ebookCopies`/`audiobookCopies` (just their `coverImagePath`) alongside the existing physical-copy fetch. `SearchResult` gains `coverImagePath: string | null`, computed via `resolveListingCover`.
- `/books/page.tsx`: its `prisma.book.findMany`'s `include` gains `ebookCopies: { select: { coverImagePath: true } }` and `audiobookCopies: { select: { coverImagePath: true } }` (physical copies already select all fields via `copies: true`). Each row computes `coverImagePath` the same way.

## Section 2: TBR sync rework + cover fetching

**Schema change:** add `coverImagePath String?` and `coverCheckedAt DateTime?` to `GoodreadsTbrItem` (see Section 4 for why `coverCheckedAt` is needed).

**Reconciliation instead of wipe-and-recreate:** `syncGoodreadsTbr` currently does `deleteMany()` + `createMany()` every sync cycle — a deliberate choice per an existing code comment, since the Goodreads RSS feed exposes no stable per-item id. That approach is incompatible with persisting a fetched cover across syncs (every row would be destroyed and recreated, losing `coverImagePath`, every 30 minutes). New approach:

1. Fetch existing `GoodreadsTbrItem` rows.
2. For each incoming shelf item, find a match:
   - Exact ISBN match against existing rows that have a non-null ISBN, via a `Map<isbn, item>` for O(1) lookup.
   - Falling back to fuzzy title matching (`findBestTitleMatch`, already exported from `src/lib/matching.ts` and used elsewhere in this codebase for the same class of problem) against the pool of existing rows not yet claimed by an ISBN match.
3. Matched rows: update `title`/`author`/`isbn` in place if changed, preserving `id`, `coverImagePath`, and `coverCheckedAt`.
4. Shelf items with no match: create fresh rows.
5. Existing rows matched to nothing on the current shelf (removed from Goodreads): delete, and clean up their cover file via the existing `deleteCoverImage` (same pattern as PR #19's orphaned-cover cleanup).

Runs as sequential individual Prisma calls, not one large transaction — matching this file's existing `applyShelfToBooks` pattern (called right after the current transactional block), and deliberately avoiding the long-held-transaction/connection-pool risk that caused the PR #17 production incident (`P2028`, "Unable to start a transaction in the given time").

**Cover fetching** reuses existing, already-hardened code: `lookupIsbn(isbn)` (`src/lib/isbnLookup.ts`) already returns an Open Library `coverUrl`; `saveCoverFromUrl(url)` (`src/lib/books.ts`) already fetches-and-saves it locally with SSRF hardening. For any TBR item with an ISBN, no `coverImagePath`, and no `coverCheckedAt` (see Section 4), call this pipeline.

**Rate-limiting:** capped at a fixed number of new cover-fetches per sync run (e.g. 25), applied after reconciliation. The initial backlog (~800 items, all missing covers on first run after this ships) fills in gradually over subsequent cron cycles (~30 min apart) instead of one long-running burst against Open Library. Applies equally to the cron and the manual "Refresh now" trigger.

Items with no ISBN never get a cover attempt at all (nothing to look up) — same placeholder behavior as any other book with no cover.

## Section 3: Backfill covers for existing ebook/audiobook copies from Audiobookshelf

Audiobookshelf's REST API exposes a per-item cover endpoint: `GET {ABS_URL}/api/items/{absItemId}/cover`, using the same `Authorization: Bearer ${ABS_TOKEN}` auth already used throughout `src/lib/absSync.ts`. Since every `EbookCopy`/`AudiobookCopy` row already stores `absItemId`, this needs no filesystem access to the user's library (which also wouldn't be available in production on the EasyPanel VPS) — just another authenticated call to a server this app already talks to.

For any `EbookCopy`/`AudiobookCopy` with an `absItemId`, no `coverImagePath`, and no `coverCheckedAt` (new field on these two models too — see Section 4), fetch `{ABS_URL}/api/items/{absItemId}/cover` and save it via the same `saveCoverFromUrl`-style pipeline as Section 2, just pointed at a different source URL/auth. Runs as part of the regular ABS sync in `absSync.ts`, same cron/manual-refresh cadence as everything else ABS-related, with the same per-run cap (e.g. 25) as Section 2.

This only backfills *existing* copies missing a cover — it doesn't change how covers are set going forward (the PR #18 upload/edit UI is unaffected).

## Section 4: Avoiding a retry-storm on permanently-missing covers

Both Section 2 and Section 3 need a way to distinguish "never attempted a cover fetch" from "attempted, but nothing was found." Without it, every sync cycle would re-attempt the same permanently-failing lookups, burning the entire per-cycle budget (Section 2/3's cap) on items that will never succeed, starving genuinely new items from ever getting fetched.

Convention: a `coverCheckedAt DateTime?` field (added to `GoodreadsTbrItem`, `EbookCopy`, and `AudiobookCopy`) is set to `now()` whenever a fetch attempt is made — success or failure alike. "Needs a fetch attempt" = `coverImagePath IS NULL AND coverCheckedAt IS NULL`. Once attempted, never auto-retried. A manual re-check mechanism is explicitly out of scope (see Non-goals).

## Section 5: UI rendering + placeholder

- Home page (`src/app/page.tsx`) and `/books` (`src/app/books/page.tsx`) list rows: thumbnail rendered above the title/author text, within the same `<li>` card. Same `h-32 w-24 rounded object-cover` sizing as the detail page, reusing the identical `<img src="/api/covers/{encodeURIComponent(path)}">` pattern and `alt="Cover"` convention already established there.
- Missing-cover placeholder: an `h-32 w-24 rounded bg-gray-100` box with a centered book icon, so every row keeps the same layout/alignment regardless of whether it has a real cover.
- `/tbr` list rows get the same treatment, using the `coverImagePath` Section 2 populates.

## Non-goals

- No lazy-loading or pagination changes to any of the three list views.
- No server-side image resizing/optimization beyond the existing CSS `object-cover` crop (matches the detail page's existing approach).
- No changes to the physical-copy scan flow's existing cover capture.
- No manual "re-check for a cover" UI or retry mechanism — a permanently-failed lookup (`coverCheckedAt` set, `coverImagePath` still null) stays uncovered until/unless a future phase adds one.
- No change to how covers are set for new ebook/audiobook copies going forward — Section 3 is a one-time backfill for existing gaps, not a change to the PR #18 upload/edit flow.

## Testing

- `src/lib/listingCover.test.ts` (new): `resolveListingCover` priority order (physical > ebook > audiobook), multiple copies within one type (first-with-a-cover wins), no cover anywhere returns `null`.
- `src/lib/goodreadsSync.test.ts`: extend with reconciliation tests — a matched-by-ISBN item preserves its `coverImagePath`/`id` across a sync; a matched-by-fuzzy-title item (no ISBN) does the same; a shelf item with no existing match creates a new row; an existing row no longer on the shelf gets deleted and its cover file cleaned up; the per-run cover-fetch cap is respected; an item with `coverCheckedAt` already set is never re-fetched even with `coverImagePath` still null.
- `src/lib/absSync.test.ts`: extend with backfill tests mirroring the above for `EbookCopy`/`AudiobookCopy` — respects the cap, respects `coverCheckedAt`, saves via the ABS cover endpoint with correct auth header.
- No page-level (`.tsx`) tests, consistent with this codebase's existing convention (verified: no `.test.ts*` files exist anywhere under `src/app`) — the three list-view changes are verified via careful diff review and a manual dev-server smoke test, same as prior UI-only tasks in this codebase's history.
