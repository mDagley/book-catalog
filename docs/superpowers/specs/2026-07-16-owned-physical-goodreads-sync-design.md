# Owned-Physical Goodreads Shelf Sync — Design Spec

Date: 2026-07-16

## Purpose

Import physical book ownership from the user's custom Goodreads shelf `owned-physical` into the catalog, so books already tagged there on Goodreads (but not yet scanned/entered in the app) get a real `Book` + `PhysicalCopy` row automatically, kept in sync going forward as new books are added to that shelf.

## Scope

- New function `syncOwnedPhysicalBooks(userId, shelfName)` in a new file, `src/lib/ownedPhysicalSync.ts`.
- Runs as an ongoing sync, alongside the existing `syncGoodreadsTbr` (to-read/currently-reading/read shelves), from both existing trigger points: the 30-minute cron job and the "Refresh now" button.
- Only ever **adds** `Book`/`PhysicalCopy` rows or leaves things alone — never deletes a `PhysicalCopy` based on a book disappearing from the shelf later. This is a deliberate safety choice: there's no way to distinguish a copy this sync created from one the user scanned/entered by hand, so removing copies based on shelf membership risks deleting real data over an unrelated shelf change (e.g., the user un-tagging a book for a reason that has nothing to do with whether they still physically own it).
- No schema changes — reuses the existing `Book`/`PhysicalCopy` tables as-is.

## Shelf Configuration

The shelf name comes from a new environment variable, `GOODREADS_OWNED_PHYSICAL_SHELF`, defaulting to `"owned-physical"` when unset — same pattern as the existing `GOODREADS_USER_ID`, in case the user ever renames the shelf on Goodreads.

`fetchAllGoodreadsBooks`/`fetchGoodreadsPage` (`src/lib/goodreadsSync.ts`) currently type their `shelf` parameter as the fixed union `GoodreadsShelf` (`"to-read" | "currently-reading" | "read"`). This is loosened to `string` so an arbitrary custom shelf name works too — the functions themselves already treat `shelf` as an opaque string passed straight into the request URL, so this is a type-only change with no behavior difference for the three existing callers.

## Sync Logic (`src/lib/ownedPhysicalSync.ts`)

For each item fetched from the configured shelf:

1. **Exact ISBN match**: if the item's normalized ISBN matches an existing `Book.isbn` exactly, that's the matched book (oldest match wins if more than one `Book` somehow shares an ISBN, via `orderBy: createdAt asc` — same determinism rule `createBookWithCopyData`'s ISBN branch already uses).
2. **Fuzzy title match fallback** (no ISBN match, or the item has no ISBN): fuzzy-match the item's title against **every** existing `Book`'s title (`findBestTitleMatch` from `src/lib/matching.ts`, same `DEFAULT_MATCH_THRESHOLD`), regardless of ownership type — candidates are **not** narrowed to digitally-owned books the way `createBookWithCopyData`'s fallback is. That narrowing exists there specifically to avoid a false-positive merge between two unrelated physical-only books; here, matching against an already-physical book is exactly what's needed to correctly detect "this book is already covered" (step 4 below). A wrong match here just means a book doesn't get imported this pass (safe, visible, fixable by hand) rather than corrupting another book's copy count.
3. **No match at all**: create a new `Book` (title, author, normalized isbn from the shelf item) with one `PhysicalCopy` (`format: "OTHER"`, since Goodreads has no concept of hardcover/paperback/etc.).
4. **Match found**:
   - If the matched `Book` already has one or more `PhysicalCopy` rows, do nothing — it's already covered.
   - Otherwise (matched book has zero physical copies today — e.g. it was ebook/audiobook-only), add one `PhysicalCopy` (`format: "OTHER"`) to it. The matched book's `title`/`author`/`isbn` are never overwritten, same safeguard every other fuzzy-match-then-attach path in this codebase uses.

Candidates for both the ISBN and fuzzy-match steps are read once at the start of a sync run (not re-queried per item), consistent with the existing sync functions' pattern, and the in-memory list is updated after each create/attach so later items in the same run see already-processed books.

Returns `{ synced: number }` (count of shelf items processed), matching the other sync functions' return shape.

## Call Sites & Error Handling

Both existing Goodreads-sync trigger points call `syncOwnedPhysicalBooks` **independently** of `syncGoodreadsTbr` — each wrapped in its own error handling, so a failure in one never prevents the other from running:

- **`src/instrumentation.ts`** (cron, every 30 minutes): the existing Goodreads `cron.schedule` block gets a second `try`/`catch` after the existing `syncGoodreadsTbr` call, logging its own success/failure independently.
- **`src/app/api/sync/goodreads/route.ts`** ("Refresh now"): both syncs are attempted; synced counts add together on full success. If either fails, the response is `{ success: false, error }` with both failures' messages combined (matching the existing simple `{ success, synced, error? }` shape `RefreshSyncButton.tsx` already expects — no UI changes needed there).

## Testing

- **`src/lib/ownedPhysicalSync.test.ts`**: exact ISBN match attaches a copy; fuzzy title match attaches a copy; a match with an existing physical copy is skipped (no second copy added); no match creates a new `Book` + `PhysicalCopy`; the matched book's title/author/isbn are never overwritten; a book removed from the shelf later keeps its existing copy (no deletion path exists to test against, but a regression test confirms calling the sync again with the item absent from the feed doesn't remove the previously-added copy). Same "distinctive test-prefix titles" real-database safety convention the other sync test files use.
- **`src/lib/goodreadsSync.test.ts`**: no changes expected beyond the `GoodreadsShelf` → `string` type loosening on `fetchGoodreadsPage`/`fetchAllGoodreadsBooks`, which existing tests already exercise via string shelf names.
- **Live verification** (matching every prior phase's pattern): after deploying, trigger a real sync and confirm real `owned-physical`-tagged books not yet in the catalog get created with a placeholder `OTHER`-format copy, books already scanned are left untouched (no duplicate copy), and the existing to-read/read-status sync is unaffected.

## Non-Goals

- No removal of `PhysicalCopy` rows based on shelf membership changes, ever — see Scope above.
- No format detection/guessing — every sync-created copy is `format: "OTHER"`, editable by hand afterward like any other copy.
- No UI changes — this is a background sync + existing "Refresh now" button, same as every other Goodreads/ABS sync in this app.
- No change to the existing to-read/currently-reading/read shelf sync (`syncGoodreadsTbr`) or its `readStatus`/`rating` logic.
