# Orphaned Cover File Cleanup — Design

## Purpose

Deleting a copy (physical via `deleteCopyData`, or ebook/audiobook via `absSync.ts`'s `removeStaleAbsLinks` when an ABS resync drops a stale item) never cleans up that copy's uploaded cover file — the DB row goes away but the file stays on disk forever. This pre-existed for physical copies since Phase 3; it became newly *reachable* for ebook/audiobook copies with the `copy-covers` phase (PR #18), since those copy types couldn't have a cover at all before then. Low real-world impact (personal single-user app, small files, low volume) but worth closing before it accumulates.

## Scope

**In scope:**
- `deleteCopyData` (`src/lib/copies.ts`) cleans up the deleted `PhysicalCopy`'s cover file.
- `removeStaleAbsLinks` (`src/lib/absSync.ts`) cleans up cover files for every stale `EbookCopy`/`AudiobookCopy` row it deletes.

**Out of scope:**
- No retroactive cleanup of files already orphaned before this fix ships — this app has no way to know a given file on disk isn't referenced by any current row without a full directory scan cross-referenced against the DB, which is a separate, riskier one-off maintenance task, not part of normal application code.
- No changes to the cover-*editing* flow (`resolveCoverUpdate`) — it already correctly cleans up a replaced cover.
- No changes to `Book`'s own deletion path beyond what already happens — when a `Book` row is deleted as a side effect of losing its last copy, any covers on the copies being removed are still cleaned up via the same per-copy logic below (a `Book` is never deleted while a copy row referencing a cover survives it).

## Implementation

### `deleteCopyData` (`src/lib/copies.ts`)

Currently selects only `{ bookId: true }` before deleting. Extend to also select `coverImagePath`, and after `prisma.physicalCopy.delete(...)` succeeds, call `deleteCoverImage(coverImagePath)` if it was non-null. `deleteCoverImage` is already best-effort (never throws, silently ignores a missing/invalid path — confirmed in `src/lib/coverStorage.ts`), so no new error handling is needed at the call site.

### `removeStaleAbsLinks` (`src/lib/absSync.ts`)

Both the ebook and audiobook branches currently `select: { id: true, bookId: true, absItemId: true }` before filtering for staleness and calling `deleteMany`. Extend each `select` to also include `coverImagePath`. After each `deleteMany` succeeds, iterate the stale copies for that media type and call `deleteCoverImage` for every one with a non-null `coverImagePath`.

### Ordering

In both cases, the database delete happens first, cover file cleanup after — matching the existing code's natural order and `resolveCoverUpdate`'s already-established stance (see its own comment) that this app's single-user, best-effort cleanup tradeoff is acceptable. This also means a row is never left un-deleted while its file is gone, only (rarely, on a transient cleanup failure) the reverse — which is exactly the class of gap this phase is fixing, just narrowed to a much smaller failure window than "never attempted at all."

## Testing

- `deleteCopyData`: new test — delete a copy that has a real cover, assert the file no longer exists on disk afterward. Existing tests (delete without a cover, delete last copy triggers book deletion) stay as-is.
- `removeStaleAbsLinks` (via `syncAbsCache`'s existing test suite in `absSync.test.ts`): new test(s) — a stale ebook/audiobook copy with a real cover gets removed by a sync pass, assert the file no longer exists on disk afterward. Mirror for both ebook and audiobook branches.

## Non-Goals

Retroactive cleanup of already-orphaned files, and any change to the cover-editing/replace flow (already correct) — see Scope above.
