# Duplicates Page Performance Fix — Design

## Overview

`/books/duplicates` (`findDuplicateBookGroups` in `src/lib/duplicates.ts`) took **111 seconds** to load in production, confirmed by directly timing an authenticated request against the live deployment. While that request was in flight, the server's single Node process was blocked closely enough that unrelated navigation (browser back button, the page's own "Back to Physical Books" link) also appeared to hang — the same failure shape as the 2026-07-18 `reconcileTbrItems` CPU incident that took the app offline.

**Root cause**: `findDuplicateBookGroups` does an all-pairs O(n²) scan over every `Book` row, calling the expensive `titleMatchScore` (Ratcliff/Obershelp fuzzy match, `src/lib/matching.ts`) for every pair where at least one side is digitally owned (`hasEbook`/`hasAudiobook`). With ~500-800 books and most digitally owned (this catalog grew out of an ABS library import), that's tens of thousands of expensive comparisons — and it re-runs on every page load, including the re-render after every merge (`revalidatePath("/books/duplicates")`).

## Fix: two-tier matching, reusing the pattern that already fixed this once

The tool's own doc comment states its purpose precisely: catching a physical copy scanned separately from an already-owned ebook/audiobook, where the physical scan's title differs only in *formatting* (series suffix, colon subtitle split, "the/a/an") from the ebook's title. `titleForms()` (`src/lib/matching.ts`) already normalizes exactly those differences into a small set of variant strings. Two books with this specific, documented kind of duplicate will almost always share an **exact** normalized form, not just a fuzzy-similar one — so most real duplicates never need a fuzzy comparison at all.

**Tier 1 (free): exact-form bucketing.** Iterate books once, building a `Map<string, DuplicateCandidate>` keyed by every `titleForms()` variant of each title (mirroring `reconcileTbrItems`'s `existingByNormalizedTitle` map from the PR #22 fix, extended to all variant forms instead of one). When a book's variant form already has an entry in the map, union the two books directly — an exact normalized-form match is guaranteed to score 100, so no `titleMatchScore` call is needed. This is O(n × avg forms-per-title), effectively free at this scale.

**Tier 2 (bounded fuzzy): capped fallback for the rest.** Keep today's existing O(n²) pair iteration (cheap on its own — plain comparisons over ~700 rows are sub-millisecond) but before calling the expensive `titleMatchScore` for a digitally-relevant pair, skip it if the pair is already unioned (tier 1 already caught it via `find(a) === find(b)`). Only pairs that are digitally-relevant AND not already grouped reach `titleMatchScore`. This is capped by a hard limit on total `titleMatchScore` calls (`FUZZY_DUPLICATE_CAP`, `1500` — measured directly against this function at ~2,500 calls/second on this hardware, notably slower than the unrelated 2026-07-18 incident's throughput, so 1500 bounds tier 2's worst case to roughly 0.6s). Once the cap is hit, remaining pairs are skipped for the rest of this run (not deferred to a later run — this page is only ever computed on-demand when visited, there's no "next sync" to catch up later) and a `truncated` flag is set.

Unlike the `#13` fuzzy-fallback design (a background sync job), this page is directly human-reviewed, so a silently truncated result could read as "no more duplicates" when detection just stopped early. When `truncated` is true:
- Log via `console.warn`, matching the existing cap-hit convention (`fetchAllGoodreadsBooks`'s `MAX_PAGES` warning).
- Show a visible notice on the page itself (e.g. "Duplicate detection stopped early after checking N comparisons — some duplicates may not be shown. Try again, or contact the maintainer if this persists.").

## Correctness trade-off (explicit, accepted)

This does **not** change matching semantics for any pair it actually compares — `titleMatchScore` and `DEFAULT_MATCH_THRESHOLD` are untouched, so no risk of the false-positive class of bug from the earlier incident (the pool-restriction/perfect-score approaches that were tried and reverted there). The only behavior change is that tier 1 resolves the documented common case without a fuzzy call, and tier 2 is bounded rather than exhaustive. In the unlikely case the cap is hit, some genuine non-exact-form duplicates might not surface in one visit — mitigated by the visible notice, and by the fact that tier 1 is expected to handle the large majority of real cases (matching this tool's own documented purpose), leaving a small residual pool for tier 2 in practice.

## Files

- Modify: `src/lib/duplicates.ts` — rewrite `findDuplicateBookGroups`'s matching loop into the two-tier shape above; change its return type from `Promise<DuplicateGroup[]>` to `Promise<{ groups: DuplicateGroup[]; truncated: boolean }>`.
- Modify: `src/app/books/duplicates/page.tsx` — destructure `{ groups, truncated }`, render the truncation notice when `truncated` is true.
- Test: `src/lib/duplicates.test.ts` — new/updated tests: (1) two books sharing an exact `titleForms()` variant are grouped without any change to existing fixture expectations (regression guard for tier 1); (2) a genuine non-exact fuzzy duplicate (existing fixture case) is still found via tier 2 when under the cap; (3) a synthetic case with many digitally-relevant candidates and no exact-form overlaps exceeds `FUZZY_DUPLICATE_CAP`, returns `truncated: true`, and logs the warning; (4) a performance regression test at realistic scale (~700 rows, mirroring the `matching.ts` lesson about testing real data volume, not just 2-3 fixtures) asserting the whole function completes well under 1 second.

## Non-goals

- No change to `titleMatchScore`, `titleForms`, or `DEFAULT_MATCH_THRESHOLD` themselves.
- No caching layer (`unstable_cache`) added for this page — the two-tier fix alone is expected to bring this well under a second, so caching isn't needed to meet the goal; can be revisited later if real-world timing says otherwise.
- No change to `mergeBooksData` or the merge flow itself (already fixed separately for its missing pending-state feedback).
- No pagination or UI changes to the duplicate-group listing itself beyond the new truncation notice.
