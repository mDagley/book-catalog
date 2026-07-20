# Cover-Fetch Robustness — Design

## Overview

Two narrow, independent fixes bundled together — both flagged in PR #21's final review, both accepted as low-priority at the time, both now being picked up (backlog items #10 and #11):

1. **`backfillAbsCovers` (`src/lib/absSync.ts`) starves audiobook cover backfill.** It fetches up to `ABS_COVER_FETCH_CAP` (25) missing-cover ebook copies and up to 25 missing-cover audiobook copies independently, then concatenates ebooks-then-audiobooks and slices to 25. Since each sub-query is already capped at 25, a library with ≥25 missing ebook covers fills the entire 25-item budget with ebooks alone — audiobooks get zero attempts until the ebook backlog drops below 25. Self-correcting eventually, but can starve audiobook covers for many cron cycles on a large library.

2. **The cover-fetch "never retry" gate conflates two different failure classes.** `coverCheckedAt` is set unconditionally after any fetch attempt (success or failure), and a non-null `coverCheckedAt` with a null `coverImagePath` permanently excludes a row from future attempts. This is correct for "we asked, there's genuinely no cover" — but two other cases get silently treated the same way:
   - **ISBN drift (TBR only):** if a `GoodreadsTbrItem` row's cover-fetch already failed (using its ISBN at the time), and a later sync corrects that row's ISBN (via `reconcileTbrItems`'s fuzzy-match reconciliation, which already updates `isbn` on the matched row when it changes), the corrected ISBN is never looked up — `coverCheckedAt` from the old, wrong ISBN's failed attempt still blocks it.
   - **Unsupported cover format (both TBR and ABS paths):** `coverStorage.ts`'s `saveCoverImage` only accepts `image/png`/`image/jpeg`/`image/webp` and throws for anything else. That throw gets swallowed into the exact same "no cover, permanent" outcome as a genuine not-found — even though a cover *was* found, just in a format this app doesn't yet save.

## Part 1: Interleave ebook/audiobook backfill

Replace the concatenate-then-slice with round-robin interleaving, alternating one ebook candidate and one audiobook candidate at a time until the combined cap is reached or both lists are exhausted:

```ts
const pending: Array<{ table: "ebook" | "audiobook"; id: string; absItemId: string }> = [];
let i = 0;
while (
  pending.length < ABS_COVER_FETCH_CAP &&
  (i < missingEbookCovers.length || i < missingAudiobookCovers.length)
) {
  if (i < missingEbookCovers.length && pending.length < ABS_COVER_FETCH_CAP) {
    pending.push({ table: "ebook", ...missingEbookCovers[i] });
  }
  if (i < missingAudiobookCovers.length && pending.length < ABS_COVER_FETCH_CAP) {
    pending.push({ table: "audiobook", ...missingAudiobookCovers[i] });
  }
  i++;
}
```

When both backlogs are large, this gives each roughly half the per-run budget instead of one starving the other entirely.

## Part 2a: Reset the cover-check gate on ISBN drift (TBR only, no schema change)

In `reconcileTbrItems`'s matched-row update branch (`src/lib/goodreadsSync.ts`), when the incoming shelf item's ISBN differs from the matched row's current ISBN **and** that row has no cover yet **and** it was already checked-and-failed, also clear `coverCheckedAt` in the same update call — the row becomes an ordinary "never checked" candidate again, picked up by `fetchMissingTbrCovers` on a later run using the corrected ISBN. If the row already has a cover, or was never checked, nothing changes (no-op either way).

## Part 2b: Distinguish unsupported-format failures from genuine not-found

**Schema:** add `coverFetchFailureReason String?` (nullable, free-form for future extension) to `GoodreadsTbrItem`, `EbookCopy`, and `AudiobookCopy` — a migration.

**Error propagation:**
- `coverStorage.ts`'s `saveCoverImage` throws a new, specifically-typed `UnsupportedCoverFormatError` (extends `Error`) for the unsupported-MIME-type case, instead of a generic `Error`. The "invalid data URL" and "too large" failure cases stay generic `Error`s — this fix is scoped to the format gap specifically, not a general failure-reason taxonomy.
- `saveCoverFromUrl` (`src/lib/books.ts`) catches `UnsupportedCoverFormatError` specifically (checked before the existing generic catch-all) and returns `{ error: "Unsupported cover image format", reason: "unsupported_format" }`. Every other failure path keeps returning the existing `{ error: string }` shape with no `reason` field.
- `fetchAbsCoverAndSave` (`src/lib/absSync.ts`) changes its return type from `string | null` to `{ coverImagePath: string } | { reason?: "unsupported_format" }`, catching `UnsupportedCoverFormatError` the same way.

**Callers:** `fetchMissingTbrCovers` and `backfillAbsCovers` both already set `coverCheckedAt: new Date()` unconditionally after every attempt (unchanged — this fix does **not** introduce automatic retries, see Non-goals). When the failure carries `reason === "unsupported_format"`, they additionally set `coverFetchFailureReason: "unsupported_format"` in that same update call. On success, `coverFetchFailureReason` is explicitly cleared to `null` (defensive — covers the unlikely case of a row that previously recorded a reason later succeeding via a different code path).

This makes previously-indistinguishable rows identifiable: `WHERE coverFetchFailureReason = 'unsupported_format'` finds every row that has a real cover sitting in Open Library/ABS that this app simply can't save yet. If `coverStorage.ts`'s supported-format list is ever expanded, those specific rows can be found and selectively reset (a one-off script or manual query, not built as part of this phase) rather than requiring a full re-scan of every "no cover" row to find the ones worth retrying.

## Non-goals

- No automatic retry cadence for unsupported-format failures. Retrying against a format-support gap that only changes via a code deploy — not via the passage of time — every 30-minute cron cycle would be pure waste, competing for the same fetch-cap budget as genuinely new items. This fix records the distinction for future manual/scripted remediation, not automatic retry.
- No change to plain network-error/not-found handling — those remain a single "not found, permanent" outcome, as already deliberately accepted in this function's history.
- No change to the "too large" or "invalid data URL" `saveCoverImage` failure cases.
- No UI surfacing of `coverFetchFailureReason` — a backend/data field only, for now.
- No change to `TBR_COVER_FETCH_CAP`/`ABS_COVER_FETCH_CAP`'s values.

## Testing

- `coverStorage.test.ts`: `saveCoverImage` throws `UnsupportedCoverFormatError` specifically for an unsupported MIME type (e.g. `image/gif`), and a plain `Error` (not that subclass) for invalid-data-url and too-large cases.
- `books.test.ts`: `saveCoverFromUrl` returns `{ error, reason: "unsupported_format" }` when the fetched cover's content-type isn't supported; existing generic-failure tests continue to assert no `reason` field.
- `absSync.test.ts`: (1) interleaving — with more than `ABS_COVER_FETCH_CAP` missing ebook covers and at least one missing audiobook cover, the audiobook candidate is included in the run (not starved); (2) `fetchAbsCoverAndSave`'s unsupported-format path sets `coverFetchFailureReason` on the copy row.
- `goodreadsSync.test.ts`: (1) a TBR row previously checked-and-failed (has an ISBN, `coverCheckedAt` set, `coverImagePath` null) has its `coverCheckedAt` reset to `null` when a sync reports a different ISBN for the same matched row; (2) `fetchMissingTbrCovers` sets `coverFetchFailureReason: "unsupported_format"` when the cover fetch fails with that reason; (3) a successful fetch clears any previously-set `coverFetchFailureReason`.
