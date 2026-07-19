# Owned-Physical Sync Duplicate Race — Design

## Overview

The user found real production data corruption: three identical `Book` rows for "A Conjuring of Light (Shades of Magic, #3)" by V.E. Schwab, each with one `PhysicalCopy`. Root-caused by reading the code (not guessed): `applyShelfItem` (`src/lib/ownedPhysicalSync.ts`) reads a snapshot of existing books once at the start of `syncOwnedPhysicalBooks`, then creates a new `Book` if nothing in that snapshot matches the incoming Goodreads shelf item. Nothing re-checks the database immediately before that `create` call.

The 30-minute cron tick (`instrumentation.ts`) has `noOverlap: true`, which prevents it from overlapping *itself* — but the manual "Refresh now" route (`api/sync/goodreads/route.ts`) has no protection against running concurrently with that cron tick (or with another manual click). If both run at once, both read "no match yet" from the same stale snapshot and both create a separate `Book` for the same title. This is the same *class* of race PR #15 already fixed once (a stale `copiesCount` snapshot before attaching a copy to an *existing* matched book) — but that fix only covers the "attach copy" path, not the "create new book" path, which never had a re-check at all.

This phase has two parts: (1) close the race so it stops happening, (2) let `/books/duplicates` clean up the physical-only duplicate rows the race already created, without reopening the false-positive risk that tool's "never group two physical-only books" rule exists to prevent.

## Part 1: Close the race

Mirror the existing, already-accepted pattern from the "attach copy" branch: re-check the database immediately before creating a new `Book`, narrowing (not eliminating — consistent with this codebase's existing risk tolerance for this exact problem class) the race window.

In `applyShelfItem`'s "no match found" branch, immediately before `prisma.book.create(...)`, re-run the same ISBN-then-fuzzy match against a **fresh** query (not the in-memory `candidates` snapshot, which could already be stale by the time this branch is reached):

```ts
if (item.isbn) {
  const freshIsbnMatch = await prisma.book.findFirst({
    where: { isbn: item.isbn },
    orderBy: { createdAt: "asc" },
    select: CANDIDATE_SELECT,
  });
  if (freshIsbnMatch) {
    // A concurrent run created this since our snapshot was taken -- handle
    // exactly like the normal match branch above (copy-attach, with its
    // own copiesCount recheck) instead of creating a duplicate.
    ...
  }
}
```

For the fuzzy-title case (no ISBN, or ISBN didn't match), re-fetch the full candidate list fresh and re-run `findBestTitleMatch` against it, one more time, immediately before create. This is a full extra query per no-match item — acceptable, since "genuinely new item, no match found" is the less common case (most shelf items are already-synced repeats matching quickly via the ISBN or in-memory fuzzy pass).

**Files:**
- Modify: `src/lib/ownedPhysicalSync.ts` — add the pre-create recheck to `applyShelfItem`'s no-match branch.
- Test: `src/lib/ownedPhysicalSync.test.ts` — new test simulating the race directly (call `applyShelfItem`-equivalent logic twice for the same shelf item without letting the first call's result reach the second call's initial candidate snapshot, assert only one `Book` row exists after both complete).

## Part 2: Narrow physical-only duplicate detection

`findDuplicateBookGroups`'s existing rule — never group two purely-physical candidates — exists because two *different* physical books can legitimately share a title (the design spec's own example: "Echo" by unrelated authors). That risk is real and this phase doesn't change it for the general case.

But a pair created by the exact race in Part 1 has a much stronger signature than "shares a title": they come from the *same* Goodreads shelf item, so they're guaranteed to share not just a title but also whatever `author`/`isbn` Goodreads reported for that item at the time. Add a second, narrow union rule specifically for this signature — physical-only pairs are still grouped if **all** of:

- They share an exact `titleForms()` variant (the existing tier-1 mechanism — not merely a fuzzy score).
- Author matches: both `null`, or normalized-equal (reusing `normalizeTitle` as a general-purpose text normalizer, not because these are titles — same lowercase/accent-strip/non-alnum-strip behavior is exactly what author-string comparison needs too).
- ISBN doesn't conflict: both `null`, one `null`, or both equal. (Both non-null and *different* excludes the pair — that's a real signal of a different edition/printing, not a sync race.)

This is additive: it only widens grouping for physical-only pairs meeting all three conditions above; every other physical-only pair (the general "Echo" case) stays excluded exactly as today.

**Files:**
- Modify: `src/lib/duplicates.ts` — add the narrow physical-only union rule to tier 1 (runs alongside the existing digital-ownership-gated union, not instead of it).
- Test: `src/lib/duplicates.test.ts` — new tests: (1) two physical-only books with exact title+author, no ISBN on either, ARE grouped (the exact production scenario); (2) two physical-only books with exact title but different non-null ISBNs are NOT grouped (different edition); (3) two physical-only books with exact title but different authors are NOT grouped (the general "Echo" case, regression guard that this doesn't get looser than intended).

## Non-goals

- No change to the ISBN-attach-to-existing-match path (already has its own recheck from PR #15).
- No change to the general physical-only exclusion for pairs that don't meet the narrow author/isbn-consistency rule above.
- No retroactive cleanup script — the user will use the (now-extended) `/books/duplicates` page to review and merge the existing "A Conjuring of Light" rows and any others like them, same as any other duplicate group.
- No change to `mergeBooksData` itself (already handles merging physical copies from multiple source books onto one).
