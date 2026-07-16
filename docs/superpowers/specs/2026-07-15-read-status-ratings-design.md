# Read Status & Ratings — Design Spec

Date: 2026-07-15

## Purpose

Track reading progress (to-read / currently-reading / read) and a 1-5 star rating for books in the catalog, sourced from the user's Goodreads shelves — the follow-on feature the catalog-data-model-unification phase was built to enable, since every owned book (physical, ebook, or audiobook) is now a real `Book` row that can carry this data directly.

## Scope

- `Book` gains `readStatus`, `readStatusManual`, `rating`, `ratingManual` fields.
- `src/lib/goodreadsSync.ts`: the existing to-read-shelf sync is extended into a combined sync that also fetches the currently-reading and read shelves, and fuzzy-matches every shelf item against existing `Book` rows to set status/rating.
- Search/browse UI gains a status badge, star rating display, and a `status`/`unrated` filter alongside the existing `types`/`format` filters.
- Book detail page gains editable status and rating controls, plus a way to revert a manual edit back to Goodreads-managed.
- No changes to `GoodreadsTbrItem`'s schema or the existing TBR-gap view's logic/behavior.
- No new Book rows are ever created by this sync — only existing catalog books can get a status/rating.

## Data Model

`Book` gains four fields:

```prisma
enum ReadStatus {
  TO_READ
  READING
  READ
}

model Book {
  id        String         @id @default(cuid())
  title     String
  author    String?
  isbn      String?
  createdAt DateTime       @default(now())
  copies    PhysicalCopy[]

  hasEbook            Boolean   @default(false)
  hasAudiobook        Boolean   @default(false)
  absEbookItemIds     String[]  @default([])
  absAudiobookItemIds String[]  @default([])
  lastAbsSyncedAt     DateTime?

  readStatus       ReadStatus?
  readStatusManual Boolean     @default(false)
  rating           Int?
  ratingManual     Boolean     @default(false)
}
```

- `readStatus` is null until either a Goodreads shelf match sets it or the user sets it manually. Three states only — no reading-history/timeline, no "did not finish," no re-read tracking.
- `rating` is an integer 1-5, null when unrated. No half-stars — matches Goodreads' own per-item shelf rating granularity.
- `readStatusManual`/`ratingManual` independently track whether each field was last set by hand in the app (`true`) or is still Goodreads-managed (`false`). They gate the sync: a sync run only writes to a field whose manual flag is `false`. Editing a field in the UI sets its flag to `true`. A separate "let Goodreads manage this again" action clears the flag (without necessarily changing the value), so the next sync can take over.
- These fields are independent of `hasEbook`/`hasAudiobook`/`abs*ItemIds` and unrelated to ABS sync entirely — a book can have any combination of ownership types and any read status.

## Sync Logic (`src/lib/goodreadsSync.ts` extension)

The existing `syncGoodreadsTbr` is extended (same external call site — cron job and "Refresh now" button both call one function, unchanged from the caller's perspective) to:

1. **Fetch all three shelves** via the existing `fetchAllGoodreadsBooks`/`fetchGoodreadsPage` (already generic over a shelf parameter): `to-read` (as today), `currently-reading` (new), `read` (new).
2. **To-read shelf → `GoodreadsTbrItem`**, exactly as today: full delete-and-recreate of the cache table, powering the existing TBR-gap view. Unchanged.
3. **Every item from all three shelves → Book matching.** Process shelves in this fixed order: to-read, then currently-reading, then read. For each shelf item, fuzzy-match its title against every existing `Book`'s title using the same `titleMatchScore`/`DEFAULT_MATCH_THRESHOLD` logic from `src/lib/matching.ts` that `absSync.ts` already uses (do not re-tune or reimplement it) — title only, not author, matching `absSync.ts`'s own matching scope exactly. If a book happens to appear on more than one shelf in the same sync (possible but atypical on Goodreads), whichever shelf is processed last among its matches wins — read shelf wins over currently-reading, which wins over to-read — matching the intuition that a "read" tag is the most definitive signal.
   - **No match:** ignored. This phase never creates a Book from a Goodreads shelf entry — only books already in the catalog can get a status/rating.
   - **Match found:**
     - If the matched Book's `readStatusManual` is `false`, set `readStatus` to the status implied by which shelf the item came from (`to-read` → `TO_READ`, `currently-reading` → `READING`, `read` → `READ`).
     - If the matched Book's `ratingManual` is `false` and the shelf item's feed rating is present and greater than 0, set `rating` to that value.
     - If a book's `*Manual` flag is `true`, that field is left untouched this sync — the manual edit stands until the user clears the flag.
4. **Rating feed field — verify before implementing.** The current Goodreads RSS parsing (`fetchGoodreadsPage`) only reads `title`/`author_name`/`isbn`/`isbn13`. Confirm during implementation (Task 1, before building the rest of the sync) that the real per-shelf RSS feed includes a per-item `user_rating` element. If it does not, ratings sync is not achievable via this feed and must be re-scoped — surface this to the user rather than silently shipping without ratings.

This is additive to the existing sync — nothing about the to-read/`GoodreadsTbrItem`/TBR-gap path changes.

## UI

**Search/browse result cards** (`src/lib/search.ts` / the page(s) rendering `SearchResult`): a status badge (e.g. "To Read" / "Reading" / "Read") shown next to the existing Physical/Ebook/Audiobook badges, and a star rating (e.g. `★★★★☆`) when `rating` is set. No badge/stars shown when `readStatus`/`rating` is null.

**Filters** (`src/lib/search.ts`'s `SearchOptions`, alongside `types`/`format`): a new `status` filter (`to_read` | `reading` | `read`, multi-select, comma-separated in the URL — same pattern as `?types=`) and an `unrated` filter (books with `rating` null). Both AND with the existing `types`/`format` filters, e.g. `?types=physical&status=reading`.

**Book detail page** (`src/app/books/[id]/page.tsx`): displays current status and rating, with:
- A status control (To Read / Reading / Read / clear) that sets `readStatus` and `readStatusManual = true` on change.
- A 1-5 star picker that sets `rating` and `ratingManual = true` on change.
- A small indicator of whether each field is "synced from Goodreads" or "manually set," with a "let Goodreads manage this again" action per field that clears its `*Manual` flag (leaving the current value in place until the next sync overwrites it).

## Testing

- **`src/lib/goodreadsSync.test.ts`**: extend with cases for fetching all three shelves; fuzzy-matching a shelf item to an existing Book and setting status/rating; skipping a field whose `*Manual` flag is true; ignoring a shelf item with no Book match (no Book created); the existing destructive-test snapshot/restore pattern extended to also snapshot/restore `readStatus`/`readStatusManual`/`rating`/`ratingManual` on any Book rows touched by a test, alongside the existing `GoodreadsTbrItem` snapshot.
- **`src/lib/search.test.ts`**: new cases for the `status` and `unrated` filters, including combined with existing `types`/`format` filters.
- **Book detail page**: verify editing status/rating sets the value and its manual flag, and that the revert action clears the flag without changing the current value.
- **Live verification** (required before this phase is done, matching every prior phase's pattern): after deploying, trigger a real sync and confirm real currently-reading/read shelf books get matched to the right catalog Book, ratings look correct, unmatched/unowned shelf books are not created as new Books, and the to-read/TBR-gap view is unchanged.

## Non-Goals

- No reading history or timeline — only the current status is stored, not a log of status changes over time.
- No "did not finish" state or re-read tracking.
- No half-star ratings.
- No creation of new `Book` rows from Goodreads shelf data — this phase only annotates books already in the catalog.
- No change to `GoodreadsTbrItem`'s schema, the TBR-gap view's matching logic, or the to-read shelf's existing sync behavior.
