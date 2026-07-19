# Cover-Fetch Race Guard + ISBN Search Coverage — Design

## Overview

Two independent, narrow fixes bundled into one phase (backlog items #9 and #14, the latter extended in scope during this design):

1. **Cover-fetch race between cron and manual "Refresh now" (#9).** `fetchMissingTbrCovers` (`src/lib/goodreadsSync.ts`) and `backfillAbsCovers` (`src/lib/absSync.ts`) each select rows where `coverCheckedAt IS NULL`, fetch a cover, then unconditionally `update({ where: { id } })`. If a cron run and a manual refresh overlap, both can fetch+save a cover for the same row; whichever `update` lands second wins, and the loser's saved cover file is never cleaned up (`deleteCoverImage` is never called for it) — a silent, permanently-orphaned file per collision.
2. **Autocomplete's `home`/`books` scopes don't match ISBN, and neither does `/tbr` itself (#14, extended).** `searchCatalog` (`src/lib/search.ts`) and `/books`' own query already detect an ISBN-shaped query and match on it; the autocomplete route's `home`/`books` branch doesn't. Separately, `/tbr`'s own search (`getTbrGap`) has never matched ISBN at all — extending autocomplete's `tbr` scope to match ISBN without also fixing `getTbrGap` itself would suggest results the `/tbr` page can't then find, so this phase fixes both together.

## Part 1: Optimistic concurrency guard on cover-fetch updates

In both `fetchMissingTbrCovers` and `backfillAbsCovers`'s per-item update call, change `prisma.<model>.update({ where: { id } })` to `prisma.<model>.updateMany({ where: { id, coverCheckedAt: null } })`. This is atomic at the database level — no residual race window between the guard check and the write.

After the call, check the returned `count`:
- `count === 1`: this run won the race (or there was no race). Normal path, nothing else to do.
- `count === 0`: another run already updated this row first (it no longer has `coverCheckedAt: null`). If *this* attempt already saved a new cover file via `saveCoverImage` earlier in the same iteration, delete it via `deleteCoverImage` before moving to the next item — the other run's write already stands as the row's authoritative state, so this attempt's file is now unreferenced and must not be left on disk.

Applied identically and independently in both files — same bug pattern, same fix, no shared helper needed (each already has its own loop shape and copy-type branching).

## Part 2: ISBN matching for /tbr and autocomplete

**`tbrGap.ts`:**
- Add `isbn: true` to `computeTbrGap`'s `prisma.goodreadsTbrItem.findMany` select, and `isbn: string | null` to the `TbrGapItem` interface.
- In `getTbrGap`'s in-memory filter, add an ISBN branch mirroring `search.ts`'s existing pattern: `const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed); const normalizedIsbnQuery = looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";`, reusing the same already-lowercased `trimmed` variable the function already computes for title/author matching (safe to reuse here: `normalizeIsbn` uppercases internally regardless of input case, and the regex already treats `X`/`x` equivalently). An item matches if title/author matches (existing behavior) OR (`normalizedIsbnQuery` is non-empty AND the item's normalized ISBN contains it).

**Autocomplete route (`route.ts`):**
- `fetchSuggestions`'s `home`/`books` branch gets the same ISBN OR-branch `searchCatalog` already has: detect an ISBN-shaped query the same way, and OR in `{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" } }` when it applies.
- The `"tbr"` branch needs no change — it already delegates to `getTbrGap(q)`, so it inherits ISBN matching for free once Part 2's `tbrGap.ts` change lands.

**`/tbr/page.tsx`:**
- Update the `SearchAutocomplete` placeholder from `"Search by title or author"` to `"Search by title, author, or ISBN"`, matching `/books`' existing wording.

## Non-goals

- No change to `searchCatalog`/`/books`' own ISBN matching — already correct, used as the reference pattern only.
- No change to the cover-fetch caps (`TBR_COVER_FETCH_CAP`, `ABS_COVER_FETCH_CAP`) or retry cadence.
- No locking/transaction changes beyond the per-row optimistic guard — this doesn't need to prevent concurrent runs from starting, only to prevent a lost update's file from leaking.
- No UI change to the ISBN behavior itself beyond the placeholder text — matching results were already rendered correctly wherever they already matched by title/author; this only widens what counts as a match.

## Testing

- `goodreadsSync.test.ts` / `absSync.test.ts`: a race is simulated by making the mocked cover-fetch call (`lookupIsbn`/the ABS cover `fetch`) perform a competing direct `prisma.<model>.update` (setting `coverCheckedAt`) as a side effect before resolving — this deterministically reproduces "another process already claimed the row by the time our own guarded update runs," inside a normal single-threaded async test. Assert: (1) the row keeps the competing write's `coverCheckedAt` value (not overwritten), (2) this attempt's own saved cover file no longer exists on disk (cleaned up via `deleteCoverImage`), (3) no error is thrown.
- `tbrGap.test.ts` (or wherever `getTbrGap`/`computeTbrGap` is currently tested): a TBR item matched only by ISBN (title/author don't contain the query) is returned when the query is the item's ISBN (or a normalizable variant, e.g. with hyphens); an item is excluded when the query is ISBN-shaped but doesn't match.
- `autocomplete` route tests: a `home`/`books`-scope request with an ISBN-shaped query returns the matching book even when title/author don't contain it.
