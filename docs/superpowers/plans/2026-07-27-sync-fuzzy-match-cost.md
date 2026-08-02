# Sync Fuzzy-Match Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `syncGoodreadsTbr`'s fuzzy-matching CPU cost by ~20× without changing a single match decision.

**Architecture:** Add a mathematically-sound cheap upper bound on the Ratcliff/Obershelp similarity score to `src/lib/matching.ts`, so pairs that cannot reach the match threshold are skipped before the expensive `O(|a|·|b|)` comparison runs. Expose it through a reusable `createTitleIndex()` that precomputes per-candidate data once per sync instead of once per shelf item. Then migrate the two hot call sites (`applyShelfToBooks`, `matchAgainstPool`) onto the index and give them the O(1) exact-title tier that `reconcileTbrItems` already has.

**Tech Stack:** TypeScript, Vitest 4, Prisma 7 + Postgres, Next.js 16 App Router.

**Spec:** `docs/superpowers/specs/2026-07-26-sync-fuzzy-match-cost-design.md`

---

## Critical context for the implementer

**Read the spec first.** Especially "Why not the obvious fixes" — a `FUZZY_FALLBACK_CAP` looks like the established pattern here and is *wrong* for `applyShelfToBooks`. Do not add one.

**This codebase has shipped a silent data-loss bug in this exact area twice.** Both times the cause was restricting *which candidates* get compared. This plan restricts *which comparisons get computed*, which is different and provably safe — but only if the bound is a true upper bound. Task 1's invariant test is the load-bearing test in this plan. Do not weaken it.

**Never run tests against the dev database.** `vitest.config.ts` enforces `.env.test`. Do not edit `.env` or `.env.test`.

**Test cleanup:** delete fixtures by tracked ID or by a distinctive title prefix that the file already uses. Several suites in this repo scan whole tables (`stats.test.ts`, `duplicates.test.ts`), so leaked fixture rows break *unrelated* suites. `goodreadsSync.test.ts` uses the `"Test Goodreads Sync "` prefix; keep using it.

**Run tests with:** `npx vitest run <path>` (do not run `next build` first — it creates `.next/` artifacts that confuse test discovery).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/matching.ts` | Title normalisation + similarity scoring | **Modify** — add `scoreUpperBound`, `createTitleIndex`; reimplement `findBestTitleMatch` on top of the index |
| `src/lib/matching.test.ts` | Unit tests for the above | **Modify** — add bound-invariant and index-equivalence tests |
| `src/lib/goodreadsSync.ts` | Goodreads sync | **Modify** — `applyShelfToBooks` gains exact tier + index; add `orderBy` at `:526` |
| `src/lib/goodreadsSync.test.ts` | Sync tests | **Modify** — tie-break + determinism tests |
| `src/lib/ownedPhysicalSync.ts` | Owned-physical sync | **Modify** — `matchAgainstPool` gains exact tier + index |
| `src/lib/ownedPhysicalSync.test.ts` | Sync tests | **Modify** — regression test that behaviour is unchanged |
| `prisma/schema.prisma` | Schema | **Modify** — add four `@@index` declarations |
| `prisma/migrations/<ts>_add_lookup_indexes/migration.sql` | Migration | **Create** |

Tasks 1–2 are pure `matching.ts` and land the whole performance win. Tasks 3–5 are call-site migrations. Task 6 is the unrelated-but-cheap index work and can be dropped without affecting anything else.

---

### Task 1: The score upper bound

The core of the design. `sequenceMatcherRatio(a, b)` returns `2M / (|a| + |b|)` where `M` is the total size of the matching blocks. Those matched characters form a common subsequence of `a` and `b`, so the character multiset of the match is contained in *both* strings. Therefore `M ≤ Σ_c min(count_a(c), count_b(c))`, giving a true upper bound on the score. Computing it is `O(|a| + |b|)`; the real ratio is `O(|a| · |b|)`.

**Files:**
- Modify: `src/lib/matching.ts`
- Test: `src/lib/matching.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/matching.test.ts`, and add `charCounts` and `scoreUpperBound` to the existing import block at the top of the file:

```ts
describe("scoreUpperBound", () => {
  it("never underestimates the real similarity score", () => {
    // The load-bearing invariant of the whole prefilter design: if the bound
    // is ever BELOW the real score, a true match gets skipped and the sync
    // silently loses data. Exercised over deliberately adversarial pairs --
    // anagrams (identical character multisets, different order) are the
    // worst case for a multiset-based bound.
    const titles = [
      "Mistborn: The Final Empire",
      "Mistborn: The Well of Ascension",
      "The Way of Kings",
      "Way of Kings",
      "Kings of the Way",
      "Café",
      "Cafe",
      "Røverne",
      "A",
      "",
      "The Hitchhiker's Guide to the Galaxy",
      "Hitchhikers Guide to the Galaxy",
      "Piranesi",
      "Parisine",
      "The Empire of Shadow (Shadow Cycle, #1)",
      "The Empire of Shadow",
    ];
    for (const a of titles) {
      for (const b of titles) {
        const bound = scoreUpperBound(a, charCounts(a), b, charCounts(b));
        const actual = sequenceMatcherRatio(a, b) * 100;
        expect(bound).toBeGreaterThanOrEqual(actual - 1e-9);
      }
    }
  });

  it("is tight for identical strings", () => {
    const s = "the way of kings";
    expect(scoreUpperBound(s, charCounts(s), s, charCounts(s))).toBeCloseTo(100, 9);
  });

  it("rejects pairs that differ too much in length to possibly match", () => {
    const a = "dune";
    const b = "the wheel of time book eleven";
    expect(scoreUpperBound(a, charCounts(a), b, charCounts(b))).toBeLessThan(85);
  });

  it("treats two empty strings as a perfect score, matching sequenceMatcherRatio", () => {
    expect(scoreUpperBound("", charCounts(""), "", charCounts(""))).toBe(100);
    expect(sequenceMatcherRatio("", "") * 100).toBe(100);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/matching.test.ts -t "scoreUpperBound"`

Expected: FAIL — `charCounts is not a function` / `scoreUpperBound is not a function` (they are not exported yet).

- [ ] **Step 3: Implement**

Add to `src/lib/matching.ts`, immediately after `sequenceMatcherRatio`:

```ts
// Character-frequency map, precomputed per string so the bound below stays
// O(|a| + |b|) rather than rebuilding both maps on every comparison.
export function charCounts(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return counts;
}

// A true UPPER BOUND on sequenceMatcherRatio(a, b) * 100, computed in
// O(|a| + |b|) instead of the ratio's own O(|a| * |b|).
//
// Why it holds: the ratio is 2M / (|a| + |b|), where M is the total size of
// the matching blocks. Those blocks are common substrings, so the characters
// they match form a common subsequence of a and b -- meaning the match's
// character multiset is contained in BOTH strings. Hence
// M <= sum_c min(count_a(c), count_b(c)), and the bound follows directly.
//
// This is a filter on WORK, not on RESULTS: when the bound is below the
// match threshold the real score cannot reach it either, so the pair is
// skipped with no possible change to any match decision. That distinction
// matters here -- two earlier attempts to speed this code up restricted
// which CANDIDATES were compared, and both silently lost real matches (see
// the long comment above reconcileTbrItems in goodreadsSync.ts).
export function scoreUpperBound(
  a: string,
  countsA: Map<string, number>,
  b: string,
  countsB: Map<string, number>,
): number {
  const total = a.length + b.length;
  // Mirrors sequenceMatcherRatio's own two-empty-strings special case.
  if (total === 0) return 100;
  // Cheap length-only bound first, since common <= min(|a|, |b|). Needs no
  // map iteration at all and rejects most pairs on its own.
  const lengthBound = (200 * Math.min(a.length, b.length)) / total;
  if (lengthBound < DEFAULT_MATCH_THRESHOLD) return lengthBound;

  let common = 0;
  // Iterate the smaller map; the result is symmetric either way.
  const [small, large] = countsA.size <= countsB.size ? [countsA, countsB] : [countsB, countsA];
  for (const [ch, n] of small) {
    const other = large.get(ch);
    if (other !== undefined) common += Math.min(n, other);
  }
  return (200 * common) / total;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/matching.test.ts`

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/matching.ts src/lib/matching.test.ts
git commit -m "feat: add a lossless upper bound on the title similarity score"
```

---

### Task 2: `createTitleIndex`

The bound only pays off if each candidate's `titleForms()` and character counts are computed **once per sync**, not once per shelf item. `findBestTitleMatch(candidates, title)` has nowhere to keep that state, so the index owns it.

`findBestTitleMatch` keeps its exact signature and behaviour — it becomes a one-shot wrapper — so every existing caller and test is unaffected.

**Files:**
- Modify: `src/lib/matching.ts`
- Test: `src/lib/matching.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/matching.test.ts`, adding `createTitleIndex` to the import block:

```ts
describe("createTitleIndex", () => {
  // Deliberately includes near-duplicates, a colon-prefix collision, an
  // accent, and a length outlier -- the shapes most likely to expose a
  // prefilter that drops real matches.
  const candidates = [
    { id: "1", title: "Mistborn: The Final Empire" },
    { id: "2", title: "Mistborn: The Well of Ascension" },
    { id: "3", title: "The Way of Kings" },
    { id: "4", title: "Words of Radiance" },
    { id: "5", title: "Café Society" },
    { id: "6", title: "Dune" },
    { id: "7", title: "The Empire of Shadow (Shadow Cycle, #1)" },
  ];

  const probes = [
    "Mistborn: The Final Empire",
    "Mistborn The Final Empire",
    "The Well of Ascension",
    "Way of Kings",
    "The Way of Kings (The Stormlight Archive, #1)",
    "Words of Radiance",
    "Cafe Society",
    "Dune",
    "Dune Messiah",
    "The Empire of Shadow",
    "Something Entirely Unrelated",
    "",
  ];

  // An INDEPENDENT reference implementation: the original unprefiltered
  // findBestTitleMatch, verbatim. It must stay independent -- comparing the
  // index against the real findBestTitleMatch would be circular, since
  // Step 3 turns that into a wrapper around createTitleIndex, and the
  // comparison would then hold even with the prefilter completely broken
  // (both sides would return null together). This reference goes through
  // titleMatchScore instead, which the prefilter never touches.
  function naiveFindBest<T extends { title: string }>(
    pool: T[],
    title: string,
    threshold = 85,
  ): T | null {
    let best: T | null = null;
    let bestScore = -1;
    for (const candidate of pool) {
      const score = titleMatchScore(candidate.title, title);
      if (score >= threshold && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  it("returns exactly what an unprefiltered scan returns, for every probe", () => {
    // THE test that protects this design. The index must be a pure
    // performance optimisation -- identical results, same object identity,
    // no exceptions. If this cannot be made to pass, the prefilter is
    // unsound and must not ship.
    const index = createTitleIndex(candidates);
    for (const probe of probes) {
      expect(index.findBest(probe)).toBe(naiveFindBest(candidates, probe));
    }
  });

  it("agrees with an unprefiltered scan at non-default thresholds too", () => {
    const index = createTitleIndex(candidates);
    for (const threshold of [50, 70, 85, 95, 100]) {
      for (const probe of probes) {
        expect(index.findBest(probe, threshold)).toBe(
          naiveFindBest(candidates, probe, threshold),
        );
      }
    }
  });

  it("keeps findBestTitleMatch's public behaviour identical as a wrapper", () => {
    for (const probe of probes) {
      expect(findBestTitleMatch(candidates, probe)).toBe(naiveFindBest(candidates, probe));
    }
  });

  it("is reusable across many lookups without mutating its candidates", () => {
    const snapshot = JSON.stringify(candidates);
    const index = createTitleIndex(candidates);
    for (const probe of probes) index.findBest(probe);
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });

  it("handles an empty candidate list", () => {
    expect(createTitleIndex([]).findBest("anything")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/matching.test.ts -t "createTitleIndex"`

Expected: FAIL — `createTitleIndex is not a function`.

- [ ] **Step 3: Implement**

Replace the existing `findBestTitleMatch` at the bottom of `src/lib/matching.ts` with:

```ts
export interface TitleIndex<T> {
  findBest(title: string, threshold?: number): T | null;
}

interface IndexedCandidate<T> {
  candidate: T;
  forms: string[];
  counts: Map<string, number>[];
}

// Builds a reusable match index over `candidates`, precomputing each one's
// titleForms() and per-form character counts ONCE. Callers that match many
// incoming items against the same pool (the sync paths) build this once and
// reuse it, instead of paying the setup cost per item.
//
// Every comparison is gated by scoreUpperBound first, so pairs that cannot
// reach the threshold never run the O(n*m) matching-blocks algorithm.
// Results are identical to a naive full scan by construction -- see
// scoreUpperBound's comment, and the equivalence test in matching.test.ts.
export function createTitleIndex<T extends { title: string }>(candidates: T[]): TitleIndex<T> {
  const indexed: IndexedCandidate<T>[] = candidates.map((candidate) => {
    const forms = titleForms(candidate.title);
    return { candidate, forms, counts: forms.map(charCounts) };
  });

  return {
    findBest(title: string, threshold: number = DEFAULT_MATCH_THRESHOLD): T | null {
      const probeForms = titleForms(title);
      const probeCounts = probeForms.map(charCounts);

      let best: T | null = null;
      let bestScore = -1;
      for (const entry of indexed) {
        let score = 0;
        for (let i = 0; i < entry.forms.length; i++) {
          for (let j = 0; j < probeForms.length; j++) {
            // Skip the expensive ratio when it provably cannot beat what we
            // already have, or cannot reach the threshold at all.
            const bound = scoreUpperBound(
              entry.forms[i],
              entry.counts[i],
              probeForms[j],
              probeCounts[j],
            );
            if (bound < threshold || bound <= score) continue;
            const candidateScore = sequenceMatcherRatio(entry.forms[i], probeForms[j]) * 100;
            if (candidateScore > score) score = candidateScore;
          }
        }
        // `>` not `>=`, matching findBestTitleMatch's original tie-breaking:
        // the FIRST candidate at the best score wins.
        if (score >= threshold && score > bestScore) {
          best = entry.candidate;
          bestScore = score;
        }
      }
      return best;
    },
  };
}

// Scans `candidates` for the best fuzzy title match to `title`, returning
// null if nothing scores at or above `threshold`. Generic over any shape
// that carries a `title` string, so every fuzzy-match-then-attach-or-create
// call site (absSync.ts, goodreadsSync.ts, createBookWithCopyData) shares
// one implementation instead of each maintaining a near-identical private
// copy.
//
// A one-shot wrapper over createTitleIndex. Callers matching MANY titles
// against the SAME pool should build the index once themselves -- this
// rebuilds it on every call.
export function findBestTitleMatch<T extends { title: string }>(
  candidates: T[],
  title: string,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): T | null {
  return createTitleIndex(candidates).findBest(title, threshold);
}
```

Note the `bound <= score` short-circuit: once a candidate has a running best score across its own forms, any form-pair whose bound cannot beat it is skipped too. This is the same soundness argument and costs nothing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/matching.test.ts`

Expected: PASS, all tests including the pre-existing `findBestTitleMatch` suite.

- [ ] **Step 5: Verify nothing else in the codebase broke**

Run: `npx vitest run`

Expected: PASS. `findBestTitleMatch` is used by `absSync.ts`, `goodreadsSync.ts`, `ownedPhysicalSync.ts`, `books.ts`, and `duplicates.ts`; their suites all exercise it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/matching.ts src/lib/matching.test.ts
git commit -m "perf: add createTitleIndex with a lossless prefilter"
```

---

### Task 3: Deterministic book ordering in `syncGoodreadsTbr`

`prisma.book.findMany({ select: STATUS_SYNC_BOOK_SELECT })` has no `orderBy`, so Postgres may return rows in any order. `findBestTitleMatch` keeps the *first* candidate at the best score, so tie-breaking is currently nondeterministic across runs. This lands before Task 4 so Task 4's tie-break test has something stable to assert against.

**Files:**
- Modify: `src/lib/goodreadsSync.ts:526`
- Test: `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe("syncGoodreadsTbr", ...)` block in `src/lib/goodreadsSync.test.ts`:

```ts
it("resolves title ties deterministically across repeated syncs", async () => {
  // Two books that fuzzy-match the same shelf item equally well. Without a
  // stable orderBy on the candidate fetch, which one receives the status is
  // whatever order Postgres happened to return.
  await prisma.book.createMany({
    data: [
      { title: "Test Goodreads Sync Mistborn: The Final Empire" },
      { title: "Test Goodreads Sync Mistborn: The Well of Ascension" },
    ],
  });

  const readWinners: (string | null)[] = [];
  for (let run = 0; run < 3; run++) {
    await prisma.book.updateMany({
      where: { title: { startsWith: "Test Goodreads Sync" } },
      data: { readStatus: null },
    });
    mockShelfFetch({
      read: [buildRssPage([{ title: "Test Goodreads Sync Mistborn", author: "Brandon Sanderson" }])],
    });
    await syncGoodreadsTbr("1993628");
    const matched = await prisma.book.findMany({
      where: { title: { startsWith: "Test Goodreads Sync" }, readStatus: "READ" },
      select: { title: true },
      orderBy: { title: "asc" },
    });
    readWinners.push(matched.map((b) => b.title).join("|") || null);
  }

  expect(new Set(readWinners).size).toBe(1);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "deterministically"`

Expected: this test may PASS by luck — Postgres often returns small tables in insertion order. That is exactly why the fix matters. If it passes, confirm the gap is real by temporarily changing the fetch at `goodreadsSync.ts:526` to `orderBy: { id: "desc" }`, re-running (the assertion still passes, since it is stable-but-different), then instead assert the *specific* winner is the alphabetically-first title and watch that fail. Restore before continuing.

Record in the commit message which of the two you observed. Do not skip this step — a test that cannot fail is not protecting anything.

- [ ] **Step 3: Implement**

In `src/lib/goodreadsSync.ts`, change line 526 from:

```ts
  const books: StatusSyncBook[] = await prisma.book.findMany({ select: STATUS_SYNC_BOOK_SELECT });
```

to:

```ts
  // Stable order so fuzzy tie-breaking is reproducible: findBestTitleMatch
  // keeps the FIRST candidate at the best score, so an unordered fetch makes
  // "which of two equally-good books got the status" vary between runs.
  // Same pattern as fetchMissingTbrCovers and backfillAbsCovers.
  const books: StatusSyncBook[] = await prisma.book.findMany({
    select: STATUS_SYNC_BOOK_SELECT,
    orderBy: { id: "asc" },
  });
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "fix: give syncGoodreadsTbr's candidate fetch a stable order"
```

---

### Task 4: `applyShelfToBooks` — exact tier + index

The main event. Adds the O(1) normalised-title tier that `reconcileTbrItems` already has, and hoists the fuzzy scan onto a `TitleIndex` built once per sync.

**A behaviour change to be deliberate about.** An exact normalised-title match scores exactly 100 — the maximum — because `normalizeTitle(t)` is always one of `titleForms(t)` and `ratio(x, x) = 1`. So the exact tier can never pick a *worse* candidate than the fuzzy scan. It can differ only in a **tie**, where another candidate also scores 100 through a different form (the "Mistborn: ..." colon-prefix collision) and sits earlier in the array. In that tie the exact tier picks the literal title match. That is the intended, more defensible outcome, and Step 1 tests it.

**Files:**
- Modify: `src/lib/goodreadsSync.ts:169-201` (`applyShelfToBooks`) and `:515-536` (`syncGoodreadsTbr`)
- Test: `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe("syncGoodreadsTbr", ...)`:

```ts
it("prefers an exact title match over an equally-scoring colon-prefix collision", async () => {
  // "Mistborn" scores 100 against "Mistborn: The Final Empire" via
  // titleForms()'s colon-split prefix form -- the same collision documented
  // above reconcileTbrItems. A book whose FULL title is exactly "Mistborn"
  // must win, even though the collision sits earlier in id order.
  const collision = await prisma.book.create({
    data: { title: "Test Goodreads Sync Mistborn: The Final Empire" },
  });
  const exact = await prisma.book.create({
    data: { title: "Test Goodreads Sync Mistborn" },
  });
  expect(collision.id < exact.id).toBe(true); // collision is scanned first

  mockShelfFetch({
    read: [buildRssPage([{ title: "Test Goodreads Sync Mistborn", author: "Brandon Sanderson" }])],
  });
  await syncGoodreadsTbr("1993628");

  const [collisionAfter, exactAfter] = await Promise.all([
    prisma.book.findUniqueOrThrow({ where: { id: collision.id }, select: { readStatus: true } }),
    prisma.book.findUniqueOrThrow({ where: { id: exact.id }, select: { readStatus: true } }),
  ]);
  expect(exactAfter.readStatus).toBe("READ");
  expect(collisionAfter.readStatus).toBeNull();
});
```

`Book.id` is `@default(cuid())` — cuid v1, which is timestamp-prefixed and therefore sorts lexicographically in creation order, so creating the collision first puts it earlier under `orderBy: { id: "asc" }`. The `expect(collision.id < exact.id)` line asserts that rather than assuming it: if it ever fails, the test has stopped exercising the adversarial ordering and would pass vacuously. **Do not delete that assertion** — if it fails, fix the fixture so the collision genuinely sorts first.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "colon-prefix"`

Expected: FAIL — `collisionAfter.readStatus` is `"READ"` and `exactAfter.readStatus` is `null`, because today's plain `findBestTitleMatch` takes the first candidate to reach 100.

- [ ] **Step 3: Implement**

In `src/lib/goodreadsSync.ts`, add `createTitleIndex` to the import from `@/lib/matching`:

```ts
import { findBestTitleMatch, normalizeTitle, isTitleMatch, createTitleIndex } from "@/lib/matching";
```

Replace `applyShelfToBooks` (lines 169–201) with:

```ts
async function applyShelfToBooks(
  shelf: GoodreadsShelf,
  items: GoodreadsBook[],
  books: StatusSyncBook[],
  matcher: ShelfMatcher,
): Promise<void> {
  const targetStatus = SHELF_READ_STATUS[shelf];

  for (const item of items) {
    const match = matcher.find(item.title);
    if (!match) continue;

    const data: { readStatus?: ReadStatus; rating?: number } = {};
    if (!match.readStatusManual && match.readStatus !== targetStatus) {
      data.readStatus = targetStatus;
    }
    if (!match.ratingManual && item.rating !== null && match.rating !== item.rating) {
      data.rating = item.rating;
    }
    if (Object.keys(data).length === 0) continue;

    const updated = await prisma.book.update({
      where: { id: match.id },
      data,
      select: STATUS_SYNC_BOOK_SELECT,
    });
    // `match` is the actual element from `books` (not a copy), so mutating
    // it in place keeps the in-memory list consistent with the DB for later
    // shelf passes -- no re-scan needed, and no risk of a stale `findIndex`
    // miss silently no-op'ing (assigning to `books[-1]`) the way a second
    // array search could. Only readStatus/rating change, never title, so
    // the matcher built from these rows stays valid across all three
    // shelves.
    Object.assign(match, updated);
  }
}
```

Add above `applyShelfToBooks`:

```ts
interface ShelfMatcher {
  find(title: string): StatusSyncBook | null;
}

// Two-tier matcher over the owned-Book pool, built ONCE per sync and reused
// for all three shelves.
//
// Tier 1 -- exact normalized title, O(1). An exact match scores exactly 100
// (normalizeTitle(t) is always one of titleForms(t), and ratio(x, x) = 1),
// which is the maximum, so this tier can never select a worse candidate
// than the fuzzy scan would. It differs only when some OTHER candidate also
// scores 100 via a different form -- the "Mistborn: The Final Empire" vs
// "Mistborn: The Well of Ascension" colon-prefix collision -- and happens to
// sort earlier. Picking the literal title match in that tie is the intended
// behaviour, and is covered by a test.
//
// Tier 2 -- fuzzy, via a prefiltered TitleIndex built once rather than per
// shelf item. Deliberately NOT capped: unlike reconcileTbrItems, where the
// items reaching fuzzy are the rare genuinely-new ones and a deferral
// resolves next sync, here every to-read item for a book that isn't owned
// reaches this tier and matches nothing on EVERY run. A cap would spend its
// budget on the same first N items each time and permanently starve the
// rest. See docs/superpowers/specs/2026-07-26-sync-fuzzy-match-cost-design.md.
function createShelfMatcher(books: StatusSyncBook[]): ShelfMatcher {
  const byNormalizedTitle = new Map<string, StatusSyncBook>();
  for (const book of books) {
    const normalized = normalizeTitle(book.title);
    // First writer wins, so ties resolve by the fetch's `orderBy: id asc`.
    if (!byNormalizedTitle.has(normalized)) byNormalizedTitle.set(normalized, book);
  }
  const index = createTitleIndex(books);

  return {
    find(title: string): StatusSyncBook | null {
      return byNormalizedTitle.get(normalizeTitle(title)) ?? index.findBest(title);
    },
  };
}
```

Then in `syncGoodreadsTbr`, replace the shelf loop (lines 526–529) with:

```ts
  const books: StatusSyncBook[] = await prisma.book.findMany({
    select: STATUS_SYNC_BOOK_SELECT,
    orderBy: { id: "asc" },
  });
  // Built once, reused for all three shelves. Rebuilding it per shelf would
  // triple the setup cost for no benefit -- applyShelfToBooks only ever
  // mutates readStatus/rating, never title.
  const matcher = createShelfMatcher(books);
  for (const shelf of STATUS_SYNC_SHELVES) {
    await applyShelfToBooks(shelf, shelfItems[shelf], books, matcher);
  }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`

Expected: PASS, including every pre-existing test — manual-override flags respected per-field, later shelves winning over earlier ones, no `Book` created from shelf data.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "perf: give applyShelfToBooks an exact tier and a reused match index"
```

---

### Task 5: `matchAgainstPool` — exact tier + index

Lower severity than Task 4: `ownedPhysicalSync` already tries ISBN first, and its shelf is much smaller. But it still does a full fuzzy scan per item, plus a **second** full scan against a freshly-fetched pool for anything that doesn't match (`ownedPhysicalSync.ts:108-113`).

The pool here is **mutated during the sync** — `applyShelfItem` pushes newly-created books onto `candidates` — so the matcher must accept additions, not be a frozen snapshot.

**Files:**
- Modify: `src/lib/ownedPhysicalSync.ts`
- Test: `src/lib/ownedPhysicalSync.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/ownedPhysicalSync.test.ts`, inside the existing top-level `describe`. This file's `mockShelfFetch` takes a **single RSS string** (unlike `goodreadsSync.test.ts`'s, which takes a per-shelf record), and its top-level `afterEach` already cleans up every row whose title starts with `"Test Owned Physical"` — so the fixture below needs no cleanup of its own:

```ts
it("still matches a book created earlier in the same sync run", async () => {
  // The candidate pool GROWS during a run. A matcher that snapshots the
  // pool up front would miss the book the first item just created, and the
  // second identical item would create a duplicate Book -- the exact bug
  // PR #27 fixed.
  mockShelfFetch(
    buildRssPage([
      { title: "Test Owned Physical Duplicate Run", author: "A" },
      { title: "Test Owned Physical Duplicate Run", author: "A" },
    ]),
  );

  await syncOwnedPhysicalBooks("1993628");

  const books = await prisma.book.findMany({
    where: { title: "Test Owned Physical Duplicate Run" },
  });
  expect(books).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/lib/ownedPhysicalSync.test.ts -t "same sync run"`

Expected: PASS against the current code (the existing implementation re-scans the mutated array each time). This is a **characterisation test** — it pins the behaviour the refactor must preserve. Confirm it passes now, so a failure after Step 3 unambiguously means the refactor broke something.

- [ ] **Step 3: Implement**

In `src/lib/ownedPhysicalSync.ts`, change the import:

```ts
import { createTitleIndex, normalizeTitle } from "@/lib/matching";
```

Replace `matchAgainstPool` (lines 35–44) with:

```ts
// The candidate pool GROWS during a sync (applyShelfItem pushes newly
// created books onto it), so this keeps an incrementally-extended index
// rather than a frozen snapshot -- a book created earlier in the same run
// must still be matchable, or the run creates duplicate rows (the bug
// PR #27 fixed).
interface PoolMatcher {
  find(item: GoodreadsBook): OwnedPhysicalCandidate | null;
  add(candidate: OwnedPhysicalCandidate): void;
}

function createPoolMatcher(pool: OwnedPhysicalCandidate[]): PoolMatcher {
  // `pool` is fetched with `orderBy: createdAt asc`, so first-writer-wins on
  // both maps deterministically keeps the OLDEST -- the same rule
  // createBookWithCopyData's ISBN branch uses, since Book.isbn has no unique
  // constraint.
  const byIsbn = new Map<string, OwnedPhysicalCandidate>();
  const byNormalizedTitle = new Map<string, OwnedPhysicalCandidate>();
  const fuzzyPool: OwnedPhysicalCandidate[] = [];

  const add = (candidate: OwnedPhysicalCandidate) => {
    if (candidate.isbn && !byIsbn.has(candidate.isbn)) byIsbn.set(candidate.isbn, candidate);
    const normalized = normalizeTitle(candidate.title);
    if (!byNormalizedTitle.has(normalized)) byNormalizedTitle.set(normalized, candidate);
    fuzzyPool.push(candidate);
  };
  for (const candidate of pool) add(candidate);

  return {
    add,
    find(item: GoodreadsBook): OwnedPhysicalCandidate | null {
      if (item.isbn) {
        const isbnMatch = byIsbn.get(item.isbn);
        if (isbnMatch) return isbnMatch;
      }
      const exact = byNormalizedTitle.get(normalizeTitle(item.title));
      if (exact) return exact;
      // Rebuilt per fuzzy miss rather than kept incrementally, because the
      // pool only grows on a genuinely-new title -- rare in steady state,
      // and the index is cheap next to the scan it replaces.
      return createTitleIndex(fuzzyPool).findBest(item.title);
    },
  };
}
```

Change `applyShelfItem`'s signature to take the matcher instead of the raw array — it no longer needs `candidates` at all, since the matcher owns the pool:

```ts
async function applyShelfItem(
  item: GoodreadsBook,
  matcher: PoolMatcher,
  createdTitles: string[],
): Promise<void> {
  const match = matcher.find(item);
```

Inside it, make exactly three further edits, leaving every existing comment in place:

1. The fresh-recheck fallback (currently lines 108–113) builds its index once:

```ts
  if (!freshMatch) {
    const freshCandidates = (
      await prisma.book.findMany({ select: CANDIDATE_SELECT, orderBy: { createdAt: "asc" } })
    ).map(toCandidate);
    freshMatch = createTitleIndex(freshCandidates).findBest(item.title);
  }
```

2. `candidates.push(freshMatch);` becomes `matcher.add(freshMatch);`
3. `candidates.push(toCandidate(created));` becomes `matcher.add(toCandidate(created));`

Then in `syncOwnedPhysicalBooks`, replace the pool setup and loop:

```ts
  const books = await prisma.book.findMany({
    select: CANDIDATE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  // Built once for the whole run; matcher.add() keeps it current as
  // applyShelfItem creates new books.
  const matcher = createPoolMatcher(books.map(toCandidate));

  const createdTitles: string[] = [];
  for (const item of items) {
    await applyShelfItem(item, matcher, createdTitles);
  }
```

The local `candidates` variable disappears entirely; `matchAgainstPool` is replaced by `createPoolMatcher` and should be deleted.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/ownedPhysicalSync.test.ts`

Expected: PASS, including the characterisation test from Step 1 and all pre-existing tests.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ownedPhysicalSync.ts src/lib/ownedPhysicalSync.test.ts
git commit -m "perf: give ownedPhysicalSync an exact tier and a reused match index"
```

---

### Task 6: Lookup indexes

**Independent of everything above.** Postgres does not auto-index foreign keys. At ~2000 rows the practical gain is a millisecond or two — this is included because it is a two-line migration, not because it is part of the CPU fix. Do not describe it as one.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_lookup_indexes/migration.sql`

- [ ] **Step 1: Add the index declarations**

In `prisma/schema.prisma`, add `@@index([bookId])` to `PhysicalCopy`, `EbookCopy`, and `AudiobookCopy`, and `@@index([isbn])` to `Book`. Place each at the end of its model block, matching the file's existing formatting.

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_lookup_indexes`

Expected: creates `prisma/migrations/<timestamp>_add_lookup_indexes/migration.sql` containing four `CREATE INDEX` statements, and applies it to the dev database.

- [ ] **Step 3: Verify the generated SQL**

Read the generated file. Expected: four `CREATE INDEX` statements and **nothing else** — no `DROP`, no `ALTER TABLE ... DROP COLUMN`. If anything destructive appears, stop: the dev database has drifted from the migration history, and applying it would lose data.

- [ ] **Step 4: Confirm the indexes exist**

Run:

```bash
docker compose exec -T postgres psql -U bookcatalog -d bookcatalog -c \
  "select tablename, indexname from pg_indexes where schemaname='public' order by tablename;"
```

Expected: the four new indexes are listed alongside the existing primary keys and the two `absItemId` unique constraints.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`

Expected: PASS. If the test database has not had the migration applied, run `npx dotenv -e .env.test -- npx prisma migrate deploy` first (or the equivalent this repo already uses) — do **not** point `prisma migrate dev` at `.env.test`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "perf: index the copy foreign keys and Book.isbn"
```

---

## Verification

Deployment needs no manual step: `docker-entrypoint.sh` runs `prisma migrate deploy`, and nothing here requires a backfill.

- [ ] **Full suite green:** `npx vitest run`
- [ ] **Lint and types:** `npm run lint` and `npx tsc --noEmit`
- [ ] **The equivalence test is real:** temporarily weaken `scoreUpperBound` to return `0` and confirm `createTitleIndex`'s equivalence test **fails**. A prefilter test that passes with a broken bound is worthless. Restore afterwards.

  This only proves anything because the test compares against the *naive reference* in Task 2. Had it compared against `findBestTitleMatch` — as an earlier draft of this plan specified — both sides would go through the broken bound, return `null` together, and the assertion would still hold. The check would report success with the prefilter entirely disabled. If you ever rewrite this test, keep the reference independent of `createTitleIndex`.
- [ ] **Measure the actual win.** Write a throwaway script (delete it afterwards — do not commit it) that seeds ~1800 books and matches ~800 titles against them, timing `findBestTitleMatch` over a plain array versus a reused `createTitleIndex`. The spec measured 18.7× for the prefilter and 21.3× with the exact tier; report what you actually observe rather than restating those numbers. A result under ~5× means something is wrong — most likely the index is being rebuilt per item somewhere.
