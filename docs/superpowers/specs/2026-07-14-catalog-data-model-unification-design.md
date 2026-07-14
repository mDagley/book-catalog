# Catalog Data Model Unification — Design Spec

Date: 2026-07-14

## Purpose

Make `Book` the single source of truth for every book the user owns — physical, ebook, or audiobook — instead of today's model where physical copies live in `Book`/`PhysicalCopy` and ebook/audiobook ownership lives in a separate `AbsCacheItem` cache table, reconciled by fuzzy title matching at search time.

This is explicitly a foundational, no-new-feature phase: after this ships, the home page search and `/tbr` gap view should look and behave identically to a user, just backed by a cleaner model. It exists to unblock two follow-on features the user wants next — read status/ratings, and (later) series tracking — both of which need a stable, real database row per owned book to attach data to, including books owned only as an ebook or audiobook that have no such row today.

## Scope

- Prisma schema: `Book` gains ebook/audiobook tracking fields; `AbsCacheItem` is dropped entirely.
- `src/lib/absSync.ts`: rewritten so the ABS sync job maintains `Book` directly (matching or creating rows) instead of upserting into a separate cache table.
- `src/lib/search.ts`: `searchCatalog`'s query-time fuzzy-merge between `Book` and `AbsCacheItem` is replaced by a single query against `Book`, since ebook/audiobook status is now stored directly on it.
- `src/lib/tbrGap.ts`: `getTbrGap` continues fuzzy-matching Goodreads titles against owned titles, but now only against one table instead of two.
- No changes to `GoodreadsTbrItem`, the Goodreads sync, the home page's URL contract (`?q=`, `?types=`, `?format=`), or any UI.
- No data migration script — the next sync (cron or manual "Refresh now") populates the new model from scratch.
- Read status/ratings and series tracking are explicitly NOT part of this phase — they're the reason this phase exists, but are separate, later specs built on top of it.

## Data Model

`Book` gains four fields:

```prisma
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
}
```

- `hasEbook`/`hasAudiobook` are plain booleans for simple, direct filtering (`where: { hasEbook: true }`) — no join, no fuzzy matching, at query time.
- `absEbookItemIds`/`absAudiobookItemIds` are scalar array columns (native to Postgres and Prisma) tracking every currently-linked ABS item ID of that media type. Arrays, not single nullable fields, because it's possible to own more than one ebook or audiobook version of the same book (e.g. an abridged and unabridged audiobook, or two different editions) — all such items link to the same `Book` row. `hasEbook`/`hasAudiobook` reflect "is the corresponding array non-empty," kept in sync by the sync logic rather than computed on read (so a plain boolean filter stays cheap).
- `lastAbsSyncedAt` records when this Book's ebook/audiobook status was last confirmed by a sync run — informational, not used for any logic in this phase.

`AbsCacheItem` (model and its enum `MediaType`, if unused elsewhere) is dropped via a real Prisma migration. `PhysicalCopy` and `GoodreadsTbrItem` are unaffected.

**No separate data migration.** The existing ~1083 real `AbsCacheItem` rows in production are not converted by a script. Once this ships, the next sync run (30-minute cron, or the user clicking "Refresh now") populates `Book.hasEbook`/`hasAudiobook`/`absEbookItemIds`/`absAudiobookItemIds` from scratch by re-running the matching logic below against the user's live ABS library — the old `AbsCacheItem` table's data is simply superseded, not carried forward. Search/TBR may show incomplete ebook/audiobook data for the (short) window between deploy and the next sync completing.

## Sync Logic (`src/lib/absSync.ts` rewrite)

For each ABS item fetched from a library (`EBOOK` or `AUDIOBOOK`, as determined by which library it came from — unchanged from today's `getMediaTypeForLibrary` substring-match logic):

1. **Fast path — already linked:** check whether any existing `Book` row has this item's ID in the relevant array (`absEbookItemIds` for an EBOOK item, `absAudiobookItemIds` for an AUDIOBOOK item). If found, this item is already correctly linked — nothing to do this pass except remember its ID was seen (for the removal pass below).
2. **First-time path — not yet linked:** fuzzy-match the item's title against every existing `Book`'s title, using the same `titleMatchScore`/`DEFAULT_MATCH_THRESHOLD` logic already in `src/lib/matching.ts` (unchanged — this is a direct port of the reference Python script's matching, already tuned against this user's real data, and should not be re-tuned or reimplemented).
   - **Match found:** append this item's ID to the matched Book's `absEbookItemIds`/`absAudiobookItemIds`, set the corresponding `hasEbook`/`hasAudiobook` to `true`, update `lastAbsSyncedAt`. Do **not** touch `title`/`author`/`isbn` on the matched Book — per an explicit design decision, ABS's metadata for the matched item is never written onto an existing Book, both to avoid a differently-formatted ABS title overwriting a good existing one, and to limit the damage of a false-positive fuzzy match (which would otherwise silently corrupt real data).
   - **No match:** create a new `Book` row with this item's title/author, no `PhysicalCopy` rows, this item's ID as the sole entry in the appropriate array, the matching `has*` flag `true`, and `lastAbsSyncedAt` set to now.
3. **Removal pass**, after all items from both libraries have been processed: for every `Book` with a non-empty `absEbookItemIds`/`absAudiobookItemIds`, remove any ID that was not seen in this sync pass (i.e., no longer present in the live ABS library). If, after this, both arrays are empty **and** the Book has zero `PhysicalCopy` rows, delete the Book entirely. If either array is still non-empty, or the Book has at least one physical copy, keep it (clearing the now-false `hasEbook`/`hasAudiobook` flag as appropriate) — this mirrors the existing zero-copy cleanup semantics already established for physical-only books (a Book with nothing backing it in any form shouldn't exist), except an ebook/audiobook-only Book with zero copies is now a normal, expected, everyday state rather than a defensive-only edge case.

This replaces `syncAbsCache`'s current upsert-by-`absItemId`-into-a-cache-table behavior entirely. `fetchAbsLibraries`/`fetchAbsLibraryItems` (the ABS API client functions) are unaffected — only what happens with their results changes.

## `search.ts` / `tbrGap.ts` Simplification

**`searchCatalog`** (`src/lib/search.ts`) becomes a single `prisma.book.findMany` call. The existing `types`/`format` filtering logic (from tonight's just-shipped search-filtering phase) is preserved conceptually but implemented far more simply:

- `types` (`physical`/`ebook`/`audiobook`) becomes a `where: { OR: [...] }` clause directly: `copies: { some: {...} } }` for `"physical"` (unchanged from today), `hasEbook: true` for `"ebook"`, `hasAudiobook: true` for `"audiobook"`. All three (or however many are selected) are OR'd together in one query, rather than two separate queries against two tables merged in JavaScript.
- `format` continues to narrow the physical side only (`copies: { some: { format } } }` and `include.copies.where`, unchanged from tonight's implementation).
- The entire post-query merge loop — the fuzzy-match-and-attach-or-push logic, `standaloneAbsResults`, and the O(n²) performance bug fixed earlier tonight — is deleted outright. There is nothing left to merge; a `Book` row already knows its own `hasEbook`/`hasAudiobook` status.
- `SearchResult`'s shape (`title`, `author`, `bookId`, `physicalCopies`, `hasEbook`, `hasAudiobook`) is unchanged — every result now always has a real `bookId` (since ebook/audiobook-only entries are real `Book` rows too), whereas today an ebook-only result has `bookId: null`. This is a meaningful, positive side effect: every search result can now link to a real book-detail page, including ebook-only books — worth confirming doesn't break anything on the book-detail page that currently assumes it's only ever reached for physically-owned books (e.g. does it handle a book with zero `PhysicalCopy` rows sensibly? Check `src/app/books/[id]/page.tsx` for this during implementation).

**`getTbrGap`** (`src/lib/tbrGap.ts`) keeps its overall shape (fetch `GoodreadsTbrItem` rows, filter out any whose title fuzzy-matches an owned title) but the "owned titles" list now comes from one `prisma.book.findMany({ select: { title: true } })` call instead of two separate queries against `Book` and `AbsCacheItem`. The existing `unstable_cache`/`revalidateTag` caching (from Phase 4) is unaffected — same cache key, same invalidation triggers, just a cheaper underlying computation (one table to scan instead of two, and a plain title list rather than a merge).

## Testing

- **`src/lib/absSync.test.ts`**: substantially rewritten. New cases: fast-path lookup by existing linked ID skips fuzzy matching; first-time fuzzy match links into an existing Book without altering its title/author; first-time no-match creates a new Book; two different ABS items (e.g. two different audiobook editions) both matching one Book both get tracked in `absAudiobookItemIds`; a removed item's ID is dropped from the array on the next sync; a Book that ends up with both arrays empty and no physical copies is deleted; a Book that still has a physical copy is kept (with its `has*` flag cleared) even after losing all linked ABS items.
- **`src/lib/search.test.ts`**: the merge-specific tests (best-scoring match, cross-item spurious merge regression, the O(n²) case) are removed, since there's no merge left to test. Replaced with simpler tests confirming `types`/`format` filtering works correctly against `Book` rows that already have `hasEbook`/`hasAudiobook` set.
- **`src/lib/tbrGap.test.ts`**: stays close to its current shape, adjusted only for the single-table query.
- **Live verification (required before this phase is done, matching every prior phase's pattern):** after deploying, trigger a real sync (cron or "Refresh now") against the user's real ABS library and confirm: physical books that also have an ebook/audiobook get linked into the same row (not duplicated), ebook-only books get their own new rows, home-page search and `/tbr` look the same to the user as they did before this phase, and the real `Book` count in production makes sense (existing physical-book count, plus new rows for ebook/audiobook-only titles that don't already have a physical copy).

## Non-Goals

- No read status, ratings, or series tracking — those are separate, later phases this one exists to enable.
- No data migration script — the next sync populates the new model.
- No change to the Goodreads sync, `GoodreadsTbrItem`, or the shelf being tracked.
- No change to the home page's or `/books`' URL contracts, UI, or user-visible behavior — this phase should be invisible to the user apart from the brief post-deploy window before the next sync completes.
- No attempt to distinguish "two ABS items with similar titles that are genuinely different books" from "two editions of the same book" beyond the existing fuzzy-match threshold — this is an inherent limitation of title-based matching that already exists today and isn't being newly introduced or specifically addressed by this phase.
