# Fuzzy-Fallback Cost Ceiling — Design

## Overview

`reconcileTbrItems` (`src/lib/goodreadsSync.ts`) syncs the user's Goodreads "to-read" shelf into `GoodreadsTbrItem`. Since PR #22 (the CPU-incident fix), each shelf item is matched against existing rows in three tiers: ISBN map (O(1)), then a cheap normalized-title map (O(1)), then — only if neither hits — a fuzzy `findBestTitleMatch` scan over the full remaining pool (O(pool)).

The first two tiers are now O(1) per shelf item, closing the specific bug that caused the 2026-07-18 production incident (every isbn-less item doing a full fuzzy scan). But the fuzzy tier itself is unchanged: still O(pool) per item that reaches it, with no upper bound on how many items can reach it in one sync run. Today's safety margin is an assumption, not an enforced limit — "most shelf items are exact-title repeats, so fuzzy rarely runs." This phase adds a hard per-sync cap on fuzzy-fallback invocations as defense-in-depth, matching the existing `TBR_COVER_FETCH_CAP`/`ABS_COVER_FETCH_CAP`/`MAX_PAGES` cap pattern already used elsewhere in this file and in `absSync.ts`.

## Behavior when the cap is hit

The cap counts **fuzzy-fallback invocations** (how many shelf items reach the fuzzy tier), not raw comparison operations — this matches the existing caps' shape (item-count limits) and needs no new bookkeeping beyond a counter.

Once the cap is reached mid-sync, every subsequent shelf item that would need the fuzzy tier is **deferred**, not treated as unmatched:
- It is NOT added to `toCreate` (would risk a duplicate row).
- Its corresponding existing row (if any) is left alone.

Critically, if the cap was hit at all during a run, **the entire delete-unmatched-rows phase is skipped for that run**. The reason: we can't tell, without doing the fuzzy match, which existing rows are "genuinely removed from the shelf" versus "the true match for a deferred item." Deleting on a capped run risks losing a row (and its cover) that a deferred item would have matched. Skipping deletion trades a stale row lingering one extra cycle for guaranteed no data loss — the same trade-off already made deliberately elsewhere in this function's history (see the two correctness-bug fixes documented in its existing comments).

Deferred items are not specially tracked between syncs — they're simply shelf items again next run (30 minutes later, or on manual refresh), when the counter resets and they get a fresh chance to match within the cap. No new persisted state.

## Cap value and logging

`FUZZY_FALLBACK_CAP = 50`, a new constant alongside `TBR_COVER_FETCH_CAP`. Reasoning: the actual incident was 80 isbn-less items each doing a full fuzzy scan against an ~800-row pool (4.5s). 50 sits comfortably below that while still covering realistic legitimate traffic (a normal sync sees at most a handful of genuinely new/renamed items, not dozens).

When the cap is hit, log via `console.warn`, matching the existing `MAX_PAGES` cap's logging convention (`fetchAllGoodreadsBooks`, line 125):

```
Goodreads TBR sync hit the fuzzy-fallback cap (50) with N shelf item(s) deferred to the next sync — row deletion skipped this run.
```

## Files

- Modify: `src/lib/goodreadsSync.ts` — add `FUZZY_FALLBACK_CAP` constant, a counter in `reconcileTbrItems`'s main loop, the deferred-item branch, and the conditional skip of the delete phase + warning log.
- Test: `src/lib/goodreadsSync.test.ts` — new tests: (1) a sync with fuzzy-needing items under the cap behaves exactly as today (regression guard); (2) a sync exceeding the cap defers the over-cap items (no new row created, existing candidate untouched) and skips deletion entirely for that run, with the warning logged; (3) a capped run's deferred item successfully reconciles on a subsequent, non-capped run.

## Non-goals

- No change to the ISBN or cheap-exact-title tiers (already O(1), already correct).
- No change to `findBestTitleMatch`/`titleMatchScore` themselves.
- No persisted "deferred item" state across syncs — a deferred item is just an ordinary shelf item again next run.
- No change to `fetchMissingTbrCovers`/`TBR_COVER_FETCH_CAP` or `absSync.ts`'s caps (separate backlog items #9-#11).
