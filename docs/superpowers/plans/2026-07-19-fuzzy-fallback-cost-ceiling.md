# Fuzzy-Fallback Cost Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hard per-sync cap on `reconcileTbrItems`'s fuzzy-fallback tier (`src/lib/goodreadsSync.ts`), as defense-in-depth against a future sync where "most shelf items are exact-title repeats" stops holding — mirroring the existing `TBR_COVER_FETCH_CAP`/`MAX_PAGES` cap pattern already used elsewhere in this file.

**Architecture:** Single additive change inside `reconcileTbrItems`'s existing per-shelf-item loop: a counter increments only when a shelf item reaches the fuzzy tier (neither ISBN nor cheap-exact-title matched). Once the counter hits `FUZZY_FALLBACK_CAP`, remaining fuzzy-needing items are skipped entirely for this run (not created, not matched) rather than treated as new — and if the cap was hit at all, the whole delete-unmatched-rows phase is skipped for that run, since we can't safely tell "genuinely removed from shelf" apart from "the true match for a deferred item" without doing the fuzzy match. A `console.warn` fires when the cap is hit, matching the existing `MAX_PAGES` warning's convention.

**Tech Stack:** TypeScript, Vitest, real dev Postgres (isolated `bookcatalog_test` DB via `.env.test`) — this file's existing test convention snapshots/restores the full `GoodreadsTbrItem` table around each test in the `syncGoodreadsTbr` describe block (see `src/lib/goodreadsSync.test.ts` lines 245-298), since `reconcileTbrItems` reads/writes that whole table, not scoped fixtures.

---

## Design spec

Full rationale and design decisions: `docs/superpowers/specs/2026-07-19-fuzzy-fallback-cost-ceiling-design.md`. Read it before starting — this plan assumes it.

## Existing code (for reference — do not copy verbatim, the exact line numbers below are current as of this plan's writing)

`src/lib/goodreadsSync.ts`, the `reconcileTbrItems` function (currently lines 291-367) and its loop:

```typescript
async function reconcileTbrItems(shelfItems: GoodreadsBook[]): Promise<void> {
  const existing = await prisma.goodreadsTbrItem.findMany({
    select: { id: true, title: true, author: true, isbn: true, coverImagePath: true },
  });

  const existingByIsbn = new Map<string, ExistingTbrItem>();
  const existingByNormalizedTitle = new Map<string, ExistingTbrItem[]>();
  for (const item of existing) {
    if (item.isbn) {
      existingByIsbn.set(item.isbn, item);
    }
    const normalized = normalizeTitle(item.title);
    const bucket = existingByNormalizedTitle.get(normalized);
    if (bucket) {
      bucket.push(item);
    } else {
      existingByNormalizedTitle.set(normalized, [item]);
    }
  }

  const matchedIds = new Set<string>();
  const toCreate: { title: string; author: string | null; isbn: string | null }[] = [];

  for (const shelfItem of shelfItems) {
    let matched: ExistingTbrItem | null = null;
    const isbnCandidate = shelfItem.isbn ? existingByIsbn.get(shelfItem.isbn) : undefined;
    if (isbnCandidate && !matchedIds.has(isbnCandidate.id)) {
      matched = isbnCandidate;
    } else {
      const normalizedShelfTitle = normalizeTitle(shelfItem.title);
      const exactCandidates = existingByNormalizedTitle.get(normalizedShelfTitle);
      matched = exactCandidates?.find((item) => !matchedIds.has(item.id)) ?? null;

      if (!matched) {
        const available = existing.filter((item) => !matchedIds.has(item.id));
        matched = findBestTitleMatch(available, shelfItem.title);
      }
    }

    if (matched) {
      matchedIds.add(matched.id);
      if (
        matched.title !== shelfItem.title ||
        matched.author !== shelfItem.author ||
        matched.isbn !== shelfItem.isbn
      ) {
        await prisma.goodreadsTbrItem.update({
          where: { id: matched.id },
          data: { title: shelfItem.title, author: shelfItem.author, isbn: shelfItem.isbn },
        });
      }
    } else {
      toCreate.push({ title: shelfItem.title, author: shelfItem.author, isbn: shelfItem.isbn });
    }
  }

  if (toCreate.length > 0) {
    await prisma.goodreadsTbrItem.createMany({ data: toCreate });
  }

  const toDelete = existing.filter((item) => !matchedIds.has(item.id));
  for (const item of toDelete) {
    if (item.coverImagePath) {
      await deleteCoverImage(item.coverImagePath);
    }
  }
  if (toDelete.length > 0) {
    await prisma.goodreadsTbrItem.deleteMany({
      where: { id: { in: toDelete.map((item) => item.id) } },
    });
  }
}

const TBR_COVER_FETCH_CAP = 25;
```

## Task 1: Add the fuzzy-fallback cap to reconcileTbrItems

**Files:**
- Modify: `src/lib/goodreadsSync.ts` (the `reconcileTbrItems` function, and add a new `FUZZY_FALLBACK_CAP` constant near the existing `TBR_COVER_FETCH_CAP` one)
- Test: `src/lib/goodreadsSync.test.ts` (inside the existing `describe("syncGoodreadsTbr", ...)` block, alongside the existing fuzzy-matching tests around line 504)

- [ ] **Step 1: Write the failing test for cap-hit behavior**

Add this helper near the top of the file, alongside `buildRssPage`/`mockShelfFetch` (both new cap tests in this task use it):

```typescript
// Deterministic pseudo-random multi-token titles for cap-testing, not a
// simple "Book ${i}" numeric suffix -- verified exhaustively (all pairs,
// see scratchpad verification during planning) that a shared literal
// prefix plus only a short differentiator (e.g. a bare index number)
// scores well above DEFAULT_MATCH_THRESHOLD via titleMatchScore's
// character-overlap algorithm, even for genuinely-meant-to-be-distinct
// fixture titles -- this shape keeps every pairwise score under ~70.
function fuzzyCapTitle(i: number): string {
  const tokens = [2654435761, 2246822519, 3266489917, 668265263].map((mult) =>
    (((i + 1) * mult) >>> 0).toString(36),
  );
  return `Test Goodreads Sync Fuzzy Cap ${tokens.join(" ")}`;
}
```

Then add this test inside the existing `describe("syncGoodreadsTbr", ...)` block (after the `"caps the number of cover fetches attempted in a single sync run"` test, so it sits near the other cap test):

```typescript
  it("stops attempting further fuzzy fallback once the cap is hit, defers the rest, and skips deletion for the run", async () => {
    // A pre-existing row that is NOT on the incoming shelf below -- if
    // deletion runs normally, this gets removed. If the cap correctly
    // makes the whole run skip deletion, it must survive.
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Goodreads Sync Cap Stale Survivor", author: "Someone" },
    });

    // 51 brand-new, isbn-less, mutually distinct titles -- none of them
    // matches anything existing (there's nothing else on the shelf or in
    // the table besides the stale survivor above, and titleMatchScore
    // between these distinct titles and "Cap Stale Survivor" is well
    // under threshold), so every single one reaches the fuzzy tier. With
    // FUZZY_FALLBACK_CAP at 50, the 51st must be deferred.
    const items = Array.from({ length: 51 }, (_, i) => ({ title: fuzzyCapTitle(i) }));
    mockShelfFetch({ "to-read": [buildRssPage(items)] });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncGoodreadsTbr("1993628");

    const created = await prisma.goodreadsTbrItem.findMany({
      where: { title: { startsWith: "Test Goodreads Sync Fuzzy Cap" } },
    });
    expect(created).toHaveLength(50);

    // Deletion was skipped for this run -- the stale survivor is still there.
    const survivor = await prisma.goodreadsTbrItem.findFirst({
      where: { title: "Test Goodreads Sync Cap Stale Survivor" },
    });
    expect(survivor).not.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fuzzy-fallback cap"));
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "stops attempting further fuzzy fallback"`

Expected: FAIL. `created` will have length 51 (no cap exists yet), the stale survivor will have been deleted (`survivor` will be `null`), and `warnSpy` will not have been called.

- [ ] **Step 3: Write the failing test for a deferred item reconciling on a later, non-capped run**

Add this test right after the one from Step 1:

```typescript
  it("lets a deferred item reconcile on a later sync once the cap isn't hit", async () => {
    // Reuses fuzzyCapTitle (not a "Book ${i}" numeric-suffix pattern) for
    // the same reason as the previous test, PLUS a second reason specific
    // to this test: on the second sync below, the deferred item's fuzzy
    // search pool includes whichever of the 50 already-created siblings
    // haven't been matched-and-excluded YET in that run's iteration order
    // -- if sibling titles were too similar to each other (verified they
    // are NOT, with this generator), the deferred item could wrongly
    // fuzzy-match an unrelated sibling instead of correctly falling
    // through to "create new."
    const items = Array.from({ length: 51 }, (_, i) => ({
      title: fuzzyCapTitle(i).replace("Fuzzy Cap", "Deferred Reconcile"),
    }));
    mockShelfFetch({ "to-read": [buildRssPage(items)] });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await syncGoodreadsTbr("1993628");
    const afterFirstSync = await prisma.goodreadsTbrItem.findMany({
      where: { title: { startsWith: "Test Goodreads Sync Deferred Reconcile" } },
    });
    expect(afterFirstSync).toHaveLength(50);

    // Same 51 shelf items again -- the 50 already-created rows now match
    // via the cheap exact-title tier (no fuzzy fallback needed at all),
    // leaving only the 1 previously-deferred item to reach the fuzzy
    // tier this run, well under the cap.
    mockShelfFetch({ "to-read": [buildRssPage(items)] });

    await syncGoodreadsTbr("1993628");
    const afterSecondSync = await prisma.goodreadsTbrItem.findMany({
      where: { title: { startsWith: "Test Goodreads Sync Deferred Reconcile" } },
    });
    expect(afterSecondSync).toHaveLength(51);
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "lets a deferred item reconcile"`

Expected: FAIL at the first assertion (`afterFirstSync` will have length 51, not 50, since no cap exists yet).

- [ ] **Step 5: Implement the cap**

In `src/lib/goodreadsSync.ts`, modify `reconcileTbrItems` (replace the whole function body between `const matchedIds = new Set<string>();` and the final closing brace) to:

```typescript
  const matchedIds = new Set<string>();
  const toCreate: { title: string; author: string | null; isbn: string | null }[] = [];
  let fuzzyFallbackCount = 0;
  let hitFuzzyFallbackCap = false;

  for (const shelfItem of shelfItems) {
    let matched: ExistingTbrItem | null = null;
    const isbnCandidate = shelfItem.isbn ? existingByIsbn.get(shelfItem.isbn) : undefined;
    if (isbnCandidate && !matchedIds.has(isbnCandidate.id)) {
      matched = isbnCandidate;
    } else {
      const normalizedShelfTitle = normalizeTitle(shelfItem.title);
      const exactCandidates = existingByNormalizedTitle.get(normalizedShelfTitle);
      matched = exactCandidates?.find((item) => !matchedIds.has(item.id)) ?? null;

      if (!matched) {
        // Needs the fuzzy fallback -- capped as defense-in-depth (see
        // FUZZY_FALLBACK_CAP's doc comment below). Once the cap is hit,
        // this and every remaining fuzzy-needing shelf item this run is
        // deferred: not added to toCreate (would risk a duplicate row for
        // an item that actually has a match, destroying its preserved
        // cover -- the exact bug this whole reconciliation rework exists
        // to prevent), and its corresponding existing row (if any) is left
        // alone. It's simply an ordinary shelf item again next sync, when
        // the counter resets.
        if (fuzzyFallbackCount >= FUZZY_FALLBACK_CAP) {
          hitFuzzyFallbackCap = true;
          continue;
        }
        fuzzyFallbackCount++;
        const available = existing.filter((item) => !matchedIds.has(item.id));
        matched = findBestTitleMatch(available, shelfItem.title);
      }
    }

    if (matched) {
      matchedIds.add(matched.id);
      if (
        matched.title !== shelfItem.title ||
        matched.author !== shelfItem.author ||
        matched.isbn !== shelfItem.isbn
      ) {
        await prisma.goodreadsTbrItem.update({
          where: { id: matched.id },
          data: { title: shelfItem.title, author: shelfItem.author, isbn: shelfItem.isbn },
        });
      }
    } else {
      toCreate.push({ title: shelfItem.title, author: shelfItem.author, isbn: shelfItem.isbn });
    }
  }

  if (toCreate.length > 0) {
    await prisma.goodreadsTbrItem.createMany({ data: toCreate });
  }

  if (hitFuzzyFallbackCap) {
    // Can't safely tell "genuinely removed from the shelf" apart from
    // "the true match for a deferred item" without doing the fuzzy match
    // -- skip deletion entirely this run rather than risk destroying a
    // row (and its cover) that a deferred item would have matched. A
    // stale row lingering one extra cycle is an acceptable trade for
    // guaranteed no data loss -- the same trade-off already made
    // deliberately elsewhere in this function's history (see the two
    // correctness-bug fixes documented in the comment above this
    // function).
    console.warn(
      `Goodreads TBR sync hit the fuzzy-fallback cap (${FUZZY_FALLBACK_CAP}) with shelf item(s) deferred to the next sync — row deletion skipped this run.`,
    );
    return;
  }

  const toDelete = existing.filter((item) => !matchedIds.has(item.id));
  for (const item of toDelete) {
    if (item.coverImagePath) {
      await deleteCoverImage(item.coverImagePath);
    }
  }
  if (toDelete.length > 0) {
    await prisma.goodreadsTbrItem.deleteMany({
      where: { id: { in: toDelete.map((item) => item.id) } },
    });
  }
}
```

Then add the new constant right before the function (after the big existing comment block that currently ends with `...this cheap-exact-then-fuzzy-on-full-pool shape is what fixes both without reintroducing the other.`, and before `async function reconcileTbrItems`):

```typescript
// Hard cap on how many shelf items may reach the fuzzy-fallback tier in a
// single sync run -- defense-in-depth, not a fix for a known bug. The
// exact-match tiers above are now O(1) per shelf item, closing the
// specific bug that caused the 2026-07-18 production incident (every
// isbn-less item doing a full fuzzy scan). But the fuzzy tier itself is
// still O(pool) per item that reaches it, with no upper bound on how many
// items can reach it in one run -- today's safety margin ("most shelf
// items are exact-title repeats, so fuzzy rarely runs") is an assumption,
// not an enforced limit. 50 sits comfortably below the actual incident's
// 80-isbn-less-items number while still covering realistic legitimate
// traffic (a normal sync sees at most a handful of genuinely new/renamed
// items, not dozens). See docs/superpowers/specs/2026-07-19-fuzzy-fallback-cost-ceiling-design.md.
const FUZZY_FALLBACK_CAP = 50;
```

- [ ] **Step 6: Run both new tests to verify they pass**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "fuzzy fallback"`

Expected: Both tests (Step 1's and Step 3's) PASS.

- [ ] **Step 7: Run the entire goodreadsSync.test.ts file to verify no regressions**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`

Expected: ALL tests pass, including every existing fuzzy-matching test (e.g. `"preserves an existing item's id and coverImagePath when matched by real fuzzy scoring, not exact title equality"`) — these exercise the fuzzy tier well under the new cap of 50, so they must behave identically to before this change. This is the regression guard for "a sync with fuzzy-needing items under the cap behaves exactly as today," called for in the design spec's Files section — no separate new test is needed for it since the existing suite already covers it.

- [ ] **Step 8: Run the full project test suite**

Run: `npm test`

Expected: ALL tests pass (290 at the time of writing, before this task's 2 new tests are added — expect 292 after).

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts`

Expected: both clean, no errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "feat: cap reconcileTbrItems's fuzzy-fallback tier as defense-in-depth

Adds FUZZY_FALLBACK_CAP (50), mirroring the existing TBR_COVER_FETCH_CAP/
MAX_PAGES cap pattern. The exact-match tiers are already O(1) per shelf
item (closing the specific bug behind the 2026-07-18 CPU incident), but
the fuzzy tier itself remains O(pool) per item that reaches it, with no
prior upper bound on how many items could reach it in one run -- this
closes that gap as defense-in-depth, not a fix for a known bug.

Once the cap is hit, remaining fuzzy-needing shelf items are deferred
(not created, existing candidates left untouched) rather than treated as
new, and the whole delete-unmatched-rows phase is skipped for that run,
since a capped run can't safely distinguish a genuinely-removed row from
the true match for a deferred item. A deferred item is simply an ordinary
shelf item again next sync."
```

## Non-goals (do not implement)

- No change to the ISBN or cheap-exact-title tiers.
- No change to `findBestTitleMatch`/`titleMatchScore` themselves.
- No persisted "deferred item" state across syncs.
- No change to `fetchMissingTbrCovers`/`TBR_COVER_FETCH_CAP` or `absSync.ts`'s caps.
