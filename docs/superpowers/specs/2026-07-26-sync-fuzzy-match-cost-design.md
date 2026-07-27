# Sync Fuzzy-Match Cost — Design Spec

## Goal

`syncGoodreadsTbr` burns minutes of CPU every 30 minutes on fuzzy title matching that
produces the same answer every run. Cut that cost without changing a single match
decision.

This is the fourth appearance of one recurring bug: *fuzzy-match every incoming item
against the entire catalogue*. It caused the 2026-07-18 production incident (CPU pegged,
Audiobookshelf starved) and the 111s `/books/duplicates` hang. Three call sites were
fixed individually. `applyShelfToBooks` was missed.

## The problem

`applyShelfToBooks` (`src/lib/goodreadsSync.ts:177`) calls `findBestTitleMatch(books,
item.title)` once per shelf item, scanning every `Book` row. It has **no exact-match tier
and no cost ceiling** — unlike `reconcileTbrItems`, `findDuplicateBookGroups`, and
`tbrGap`, which all got one. `syncGoodreadsTbr` then runs it for **three** shelves
(`STATUS_SYNC_SHELVES = ["to-read", "currently-reading", "read"]`) on a `*/30 * * * *`
cron.

Two secondary sites, both lower severity:

- **`ownedPhysicalSync.ts:43`** — `matchAgainstPool` does a full fuzzy scan per shelf
  item. Items that match nothing then do a **second** full scan against a freshly-fetched
  pool (`:112`). It already tries ISBN first, so it is better off than
  `applyShelfToBooks`, but has no exact-title tier.
- **`absSync.ts:498`** — same shape, but guarded by `linkedIds.has(item.absItemId)`, which
  acts as an exact tier. Effectively first-sync-only. **No change needed.**

### Measured cost

A synthetic pool of 1800 books and a shelf of 800 items, 10% of which correspond to owned
books (the rest are to-read books not in the catalogue, which is the common case):

| | Time |
|---|---|
| One shelf, current implementation | **61.6s** |
| Three shelves (extrapolated) | **~185s** |

For scale, the 2026-07-18 incident that pegged the VPS was **4.5s** of this same work.

**Caveats, stated plainly.** The titles are synthetic; real titles are likely shorter and
cheaper per comparison. An earlier per-item measurement this session gave 29.6ms/item
against an 1800-book pool, which extrapolates to ~24s per shelf rather than ~61s. The
shelf sizes are assumed, not observed. What is *not* in doubt: the work is tens of seconds
per shelf, ×3 shelves, every 30 minutes, and it recomputes an answer that almost never
changes. The local dev database is empty (the Docker volume was reset), and the live site
is behind auth, so real shelf sizes could not be measured — see Open questions.

### Why not the obvious fixes

**Memoising `titleForms`** — measured **1.62×**. `titleForms` is only 7.4ms per 1800
titles; the cost is `sequenceMatcherRatio` itself, which is inherent. Not a fix.

**A `FUZZY_FALLBACK_CAP`, as used in `reconcileTbrItems`** — wrong here. In
`reconcileTbrItems`, items reaching the fuzzy tier are the rare genuinely-new ones, and a
deferred item resolves next sync. In `applyShelfToBooks`, every to-read item for a book
you *don't own* reaches the fuzzy tier and matches nothing — **every run, forever**. A cap
of 50 over ~750 such items would burn the budget on the same first 50 each run (the
iteration order is stable) and permanently starve everything after them. It never
converges. A cap is the right tool only when the capped population is transient.

## The fix: a lossless prefilter

`titleMatchScore` compares every `titleForms()` variant of one title against every variant
of the other, using `sequenceMatcherRatio` — the Ratcliff/Obershelp ratio:

```
ratio = 2 * M / (|a| + |b|)          M = total size of matching blocks
```

The matched characters form a common subsequence of `a` and `b`, so their character
multiset is contained in both. Therefore:

```
M ≤ common(a, b)        where common = Σ_c min(count_a(c), count_b(c))
```

which gives a genuine **upper bound** on the score:

```
score ≤ 200 * common(a, b) / (|a| + |b|)
```

Computing `common` is `O(|a| + |b|)`. Computing the real ratio is `O(|a| · |b|)`. So when
the bound falls below the match threshold (85), the pair can be **skipped outright** — the
real score cannot possibly reach the threshold. This changes no match decision, ever. It
is a filter on work, not on results.

A cheaper bound applies first, needing no character counts at all, since
`common ≤ min(|a|, |b|)`:

```
score ≤ 200 * min(|a|, |b|) / (|a| + |b|)
```

A 10-character title can never match a 30-character one: `200·10/40 = 50 < 85`.

### Measured

Same 1800-book / 800-item workload:

| | Time | Matches found |
|---|---|---|
| Current | 61.6s | 267 |
| Prefilter | **3.3s** (18.7×) | **267** |
| Prefilter + exact-title tier | **2.9s** (21.3×) | **267** |

Match counts are identical, which is the point. A separate correctness sweep over **45,000
title pairs** compared filtered against unfiltered scoring and found **0 decision
mismatches**.

Three shelves: **~185s → ~8.7s**, from roughly a 10% CPU duty cycle to roughly 0.5%.

### API shape

The prefilter only pays off if candidate forms and character counts are computed **once per
sync**, not once per shelf item. `findBestTitleMatch(candidates, title)` has no place to
hang that state, so `src/lib/matching.ts` gains:

```ts
export interface TitleIndex {
  findBest<T extends { title: string }>(title: string, threshold?: number): T | null;
}
export function createTitleIndex<T extends { title: string }>(candidates: T[]): TitleIndex;
```

`createTitleIndex` precomputes each candidate's `titleForms()` and per-form character
counts. Callers build the index once and reuse it across every item.

`findBestTitleMatch` **stays**, reimplemented as a one-shot wrapper
(`createTitleIndex(candidates).findBest(title)`). Every existing caller and test keeps
working unchanged; only the hot loops migrate to the index.

## Secondary changes

### Exact-title tier

`applyShelfToBooks` and `matchAgainstPool` gain the O(1) normalised-title map that
`reconcileTbrItems` already uses (`existingByNormalizedTitle`).

This is a small behaviour change and must be understood rather than assumed safe. An exact
normalised-title match scores exactly **100**, the maximum, because `normalizeTitle(t)` is
always one of `titleForms(t)` and `ratio(x, x) = 1`. So an exact match is always a maximal
scorer — the tier can never select a *worse* candidate than the fuzzy scan would. It can
differ only in a **tie**, where some other candidate also scores 100 via a different form
(the documented "Mistborn: The Final Empire" vs "Mistborn: The Well of Ascension"
colon-prefix collision) and happens to sit earlier in the array. In that tie the exact tier
picks the literal title match, which is the more defensible of the two. This needs a test,
not a comment.

It is deliberately a *string-equality* tier, never a score threshold on a restricted pool
— that is the shape that reintroduced data loss once already (see the long comment above
`reconcileTbrItems`).

### Missing `orderBy`

`syncGoodreadsTbr` fetches `prisma.book.findMany({ select: STATUS_SYNC_BOOK_SELECT })`
with **no `orderBy`** (`goodreadsSync.ts:526`). Postgres may return rows in any order, so
fuzzy tie-breaking — `findBestTitleMatch` keeps the *first* candidate at the best score —
is nondeterministic across runs. Add `orderBy: { id: "asc" }`, matching the existing
pattern in `fetchMissingTbrCovers` and `backfillAbsCovers`.

Minor on its own, but it makes the exact-tier tests above deterministic, so it lands first.

### Indexes

The database has only primary keys and the two `@unique` constraints on `absItemId`.
Postgres does not auto-index foreign keys, so `PhysicalCopy.bookId`, `EbookCopy.bookId`,
and `AudiobookCopy.bookId` are unindexed, as is `Book.isbn` despite per-item lookups at
`books.ts:79` and `ownedPhysicalSync.ts:102`.

**Honestly assessed: minor.** At ~2000 rows a sequential scan is a millisecond or two.
Included because it is a two-line migration and the lookups are per-item inside sync loops,
not because it is worth much. It must not be presented as part of the CPU fix.

## Non-goals

- **No cap on `applyShelfToBooks`'s fuzzy tier.** Analysed above: the population reaching
  it is permanent, so a cap starves rather than defers. The prefilter removes the need.
- **No ISBN tier in `applyShelfToBooks`.** Goodreads supplies `isbn13` often, and matching
  on it would likely be *more* accurate than fuzzy title — but that is a correctness change
  with its own risks, and the exact-title tier already removes the cost motivation. If
  wanted, it deserves its own spec.
- **No change to `absSync.ts`.** Its `linkedIds` guard already makes it first-sync-only. It
  still benefits automatically from the prefilter.
- **No change to the matching algorithm, `titleForms`, or the 85 threshold.** These are
  tuned against real Goodreads/ABS data. The prefilter sits strictly in front of them.
- **No persisted match cache.** Storing shelf-item→book decisions in the database would cut
  the work further, but it adds schema, invalidation, and a staleness failure mode to fix a
  problem the prefilter already reduces by ~21×.

## Testing

- **The lossless claim, as an equivalence test.** Over a corpus of real-shaped title pairs
  (series suffixes, colon subtitles, accents, articles, near-duplicates, length
  mismatches), assert `createTitleIndex(candidates).findBest(t)` returns exactly what
  `findBestTitleMatch(candidates, t)` returns — same object, for every `t`. This is the
  test that protects the whole design; if it can't be made to pass, the design is wrong.
- **The bound invariant, directly.** For every pair in that corpus, assert
  `upperBound(a, b) >= titleMatchScore(a, b)`. A bound that is ever too low silently drops
  matches, which is exactly the failure mode this codebase has already shipped twice.
- **Exact-tier tie-breaking.** Seed two books colliding on a colon prefix plus one exact
  title match; assert the exact match wins regardless of insertion order.
- **Determinism.** Run a sync twice against the same fixture and assert identical
  `readStatus`/`rating` results — this is what the `orderBy` fix buys.
- **`applyShelfToBooks` behaviour is unchanged**, per the existing suite: manual-override
  flags still respected per-field, later shelves still win, no `Book` ever created.
- Per this project's convention, seed real rows and assert on real query output. Clean up
  by tracked ID, not title prefix — `books.test.ts` cleans via `createdBookIds`, and
  copying the wrong cleanup pattern has broken unrelated suites three times this session.

## Open questions

Real shelf sizes are unknown — the local dev database is empty and the live site requires
authentication. The design does not depend on them (the prefilter is a pure win at any
scale), but they would sharpen the "how bad is it today" number. Either a login for the
live site or the row counts from `/stats` would settle it.
