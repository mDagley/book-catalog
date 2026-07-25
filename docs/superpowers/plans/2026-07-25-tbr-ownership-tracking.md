# TBR Ownership Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `computeTbrGap`'s per-request O(TBR items × owned books) fuzzy title-matching scan (measured ~50s at realistic scale) with a persisted `owned` boolean on `GoodreadsTbrItem`, maintained incrementally by every code path that changes the TBR list or the owned-book set.

**Architecture:** Add `owned Boolean @default(false)` to `GoodreadsTbrItem`. Two new small functions in `tbrGap.ts` — `markTbrItemsOwnedByTitle` (checks only currently-unowned items against one new title) and `recheckOwnedTbrItems` (re-verifies only currently-owned items against the current owned set) — get called from every place a `Book`'s existence or title changes. `computeTbrGap` becomes a plain `WHERE owned = false` query. The `unstable_cache`/`revalidateTag` layer around it is removed entirely since the query is no longer expensive. A one-time backfill script computes the initial values for existing rows.

**Tech Stack:** TypeScript, Prisma (Postgres), Vitest, Next.js 16 route handlers.

**Spec:** `docs/superpowers/specs/2026-07-25-performance-fixes-design.md` (TBR section only — the `/books` pagination section is a separate plan).

---

### Task 1: Schema — add `owned` column

**Files:**
- Modify: `prisma/schema.prisma:76-85`

- [ ] **Step 1: Add the field**

```prisma
model GoodreadsTbrItem {
  id                      String    @id @default(cuid())
  title                   String
  author                  String?
  isbn                    String?
  coverImagePath          String?
  coverCheckedAt          DateTime?
  coverFetchFailureReason String?
  lastSyncedAt            DateTime  @default(now())
  owned                   Boolean   @default(false)
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npx prisma migrate dev --name add_tbr_owned_flag`

Expected: a new folder under `prisma/migrations/` containing a `migration.sql` with exactly one `ALTER TABLE "GoodreadsTbrItem" ADD COLUMN "owned" BOOLEAN NOT NULL DEFAULT false;` statement (Prisma generates this automatically from the schema diff — no hand-editing needed, unlike the `unify_copy_types` migration, since there's no data transformation expressible in this migration's own SQL).

- [ ] **Step 3: Verify**

Run: `npx prisma generate` (if not run automatically by the migrate command), then confirm the Prisma Client's `GoodreadsTbrItem` type now has an `owned: boolean` field by checking `node_modules/.prisma/client/index.d.ts` or just proceeding to Task 2 (TypeScript will fail to compile there if this step didn't work).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add owned flag to GoodreadsTbrItem"
```

---

### Task 2: `markTbrItemsOwnedByTitle`

**Files:**
- Modify: `src/lib/tbrGap.ts`
- Test: `src/lib/tbrGap.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/tbrGap.test.ts` (new `describe` block, alongside the existing `getTbrGap`/`groupByInitial` ones):

```ts
describe("markTbrItemsOwnedByTitle", () => {
  it("flips a currently-unowned matching item to owned", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mark Elantris", author: "Brandon Sanderson" },
    });

    await markTbrItemsOwnedByTitle("Test TBR Mark Elantris");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(true);
  });

  it("leaves a non-matching item unowned", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mark Unrelated", author: "Someone" },
    });

    await markTbrItemsOwnedByTitle("Test TBR Mark Completely Different Book");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(false);
  });

  it("does not re-query or touch an already-owned item", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mark Already Owned", author: "Someone", owned: true },
    });

    await markTbrItemsOwnedByTitle("Test TBR Mark Already Owned");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(true);
  });
});
```

Add the import at the top of the test file: `markTbrItemsOwnedByTitle` alongside the existing `getTbrGap, groupByInitial` import from `@/lib/tbrGap`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tbrGap.test.ts`
Expected: FAIL — `markTbrItemsOwnedByTitle is not a function` (or a TypeScript import error).

- [ ] **Step 3: Implement**

Add to `src/lib/tbrGap.ts`, after the existing imports (add `isTitleMatch` to the existing `import { normalizeIsbn } from "@/lib/books";` line's neighbor — add a new import line `import { isTitleMatch } from "@/lib/matching";`), placed after `computeTbrGap`'s definition and before `getCachedTbrGap`/`getTbrGap` (exact placement doesn't matter functionally, but keep it near the other exported functions for readability):

```ts
// Call whenever a new owned title starts existing (a Book is created, or an
// existing Book's title changes to something new). Checks only currently-
// unowned TBR items against this ONE title -- O(unowned TBR items), not the
// full owned-books cross product -- and flips any fuzzy match to owned.
export async function markTbrItemsOwnedByTitle(title: string): Promise<void> {
  const unowned = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true },
  });
  const nowOwnedIds = unowned
    .filter((item) => isTitleMatch(item.title, title))
    .map((item) => item.id);
  if (nowOwnedIds.length === 0) return;
  await prisma.goodreadsTbrItem.updateMany({
    where: { id: { in: nowOwnedIds } },
    data: { owned: true },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tbrGap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/tbrGap.ts src/lib/tbrGap.test.ts
git commit -m "feat: add markTbrItemsOwnedByTitle"
```

---

### Task 3: `recheckOwnedTbrItems`

**Files:**
- Modify: `src/lib/tbrGap.ts`
- Test: `src/lib/tbrGap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("recheckOwnedTbrItems", () => {
  it("flips an owned item to unowned when no current Book matches it", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recheck Orphaned", author: "Someone", owned: true },
    });

    await recheckOwnedTbrItems();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(false);
  });

  it("leaves an owned item alone when a current Book still matches it", async () => {
    await prisma.book.create({ data: { title: "Test TBR Recheck Still Owned" } });
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recheck Still Owned", author: "Someone", owned: true },
    });

    await recheckOwnedTbrItems();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(true);
  });

  it("never queries or touches an already-unowned item", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recheck Untouched", author: "Someone", owned: false },
    });

    await recheckOwnedTbrItems();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tbrGap.test.ts`
Expected: FAIL — `recheckOwnedTbrItems is not a function`

- [ ] **Step 3: Implement**

Add to `src/lib/tbrGap.ts`, right after `markTbrItemsOwnedByTitle`:

```ts
// Call whenever an owned title stops existing (a Book is deleted, or an
// existing Book's title changes away from its old value). Re-verifies only
// currently-owned TBR items against the full current owned-title list --
// bounded by how many TBR items have ever matched an owned book, not the
// full TBR list -- and flips any that no longer match back to unowned.
export async function recheckOwnedTbrItems(): Promise<void> {
  const [owned, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({
      where: { owned: true },
      select: { id: true, title: true },
    }),
    prisma.book.findMany({ select: { title: true } }),
  ]);
  if (owned.length === 0) return;
  const ownedTitles = books.map((b) => b.title);
  const noLongerOwnedIds = owned
    .filter((item) => !ownedTitles.some((title) => isTitleMatch(item.title, title)))
    .map((item) => item.id);
  if (noLongerOwnedIds.length === 0) return;
  await prisma.goodreadsTbrItem.updateMany({
    where: { id: { in: noLongerOwnedIds } },
    data: { owned: false },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tbrGap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/tbrGap.ts src/lib/tbrGap.test.ts
git commit -m "feat: add recheckOwnedTbrItems"
```

---

### Task 4: Simplify `computeTbrGap`, drop the cache

**Files:**
- Modify: `src/lib/tbrGap.ts`
- Modify: `src/lib/tbrGap.test.ts`

This task rewrites the two tests that currently rely on `getTbrGap()` dynamically computing ownership (lines 18-46 of the current `tbrGap.test.ts`) — under the new design, a raw `prisma.goodreadsTbrItem.create()` no longer triggers any ownership computation, so those tests must exercise `markTbrItemsOwnedByTitle` (the real function that would run in production) rather than expecting `getTbrGap` itself to notice a newly-created owned Book.

- [ ] **Step 1: Write the failing/updated tests**

Replace the two existing tests (currently titled "excludes a TBR item that matches an owned physical book" and "excludes a TBR item that matches an ebook/audiobook-only Book") with:

```ts
  it("excludes a TBR item marked owned", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Owned Flag Set", author: "Someone", owned: true },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Owned Flag Set")).toBe(false);
  });

  it("reflects real ownership end-to-end: creating a matching Book, then marking, excludes the item", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Owned End To End", author: "Someone" },
    });
    expect(
      (await getTbrGap()).some((item) => item.title === "Test TBR Owned End To End"),
    ).toBe(true);

    await prisma.book.create({ data: { title: "Test TBR Owned End To End" } });
    await markTbrItemsOwnedByTitle("Test TBR Owned End To End");

    expect(
      (await getTbrGap()).some((item) => item.title === "Test TBR Owned End To End"),
    ).toBe(false);
  });
```

Also add one new test confirming the cache/env-branch removal didn't leave a dangling behavior difference:

```ts
  it("reflects a change immediately with no caching delay", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR No Cache Delay", author: "Someone" },
    });
    expect((await getTbrGap()).some((i) => i.title === "Test TBR No Cache Delay")).toBe(true);

    await prisma.goodreadsTbrItem.update({ where: { id: item.id }, data: { owned: true } });

    expect((await getTbrGap()).some((i) => i.title === "Test TBR No Cache Delay")).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify the new ones behave as expected against the OLD implementation**

Run: `npm test -- tbrGap.test.ts`
Expected: the two rewritten tests and the new caching test should already PASS against the current implementation (they're testing real end-to-end behavior, not the internals) — this step is a sanity check, not a strict red/green gate, since we're refactoring `computeTbrGap`'s internals rather than adding new externally-visible behavior. If any fail unexpectedly, investigate before proceeding.

- [ ] **Step 3: Implement — simplify `computeTbrGap` and `getTbrGap`, drop the cache**

Replace the whole current `tbrGap.ts` file content from the top through the end of `getTbrGap` (i.e., everything except the `sortKey`/`letterBucket` helpers, `TbrGapItem` interface, `TbrGapGroup`/`groupByInitial`, and the new `markTbrItemsOwnedByTitle`/`recheckOwnedTbrItems` added in Tasks 2-3) with:

```ts
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";
import { normalizeIsbn } from "@/lib/books";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
  coverImagePath: string | null;
  isbn: string | null;
}

// ...sortKey, letterBucket unchanged...

async function computeTbrGap(): Promise<TbrGapItem[]> {
  const tbrItems = await prisma.goodreadsTbrItem.findMany({
    where: { owned: false },
    select: { id: true, title: true, author: true, coverImagePath: true, isbn: true },
  });

  return tbrItems
    .map((tbr) => ({
      id: tbr.id,
      title: tbr.title,
      author: tbr.author,
      coverImagePath: tbr.coverImagePath,
      isbn: tbr.isbn,
    }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: "base" }));
}

// `query` is applied in-memory, after the DB query, against the full
// (already sorted) gap list -- filtering ~800 items in-process is cheap, and
// avoids a per-query DB round trip for what would otherwise be an unbounded
// set of possible query strings.
export async function getTbrGap(query?: string): Promise<TbrGapItem[]> {
  const gap = await computeTbrGap();

  const trimmed = query?.trim().toLowerCase();
  if (!trimmed) return gap;

  // Mirrors search.ts's isbn-shaped-query detection: reusing the same
  // already-lowercased `trimmed` is safe here because normalizeIsbn
  // uppercases internally regardless of input case, and the regex already
  // treats X/x equivalently.
  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed);
  const normalizedIsbnQuery = looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";

  return gap.filter(
    (item) =>
      item.title.toLowerCase().includes(trimmed) ||
      (item.author?.toLowerCase().includes(trimmed) ?? false) ||
      (normalizedIsbnQuery !== "" &&
        item.isbn !== null &&
        normalizeIsbn(item.isbn).includes(normalizedIsbnQuery)),
  );
}
```

Remove: the `unstable_cache` import, `TBR_GAP_CACHE_TAG` export, `getCachedTbrGap` constant, and the block comment above it explaining the cron/revalidateTag caveat (no longer applicable — `computeTbrGap` is called directly now, no cache to warm or invalidate for either cron or manual syncs).

- [ ] **Step 4: Run tests to verify everything passes**

Run: `npm test -- tbrGap.test.ts`
Expected: PASS, all tests including the ones from Tasks 2-3.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tbrGap.ts src/lib/tbrGap.test.ts
git commit -m "refactor: computeTbrGap reads the owned flag directly, drop unstable_cache"
```

---

### Task 5: Remove `revalidateTag` from the sync routes

**Files:**
- Modify: `src/app/api/sync/abs/route.ts`
- Modify: `src/app/api/sync/goodreads/route.ts`

No new tests — this is dead-code removal now that Task 4 deleted `TBR_GAP_CACHE_TAG`, so leaving the imports in place would fail to compile.

- [ ] **Step 1: Update `src/app/api/sync/abs/route.ts`**

```ts
import { NextResponse } from "next/server";
import { syncAbsCache } from "@/lib/absSync";

export async function POST() {
  const absUrl = process.env.ABS_URL;
  const absToken = process.env.ABS_TOKEN;

  if (!absUrl || !absToken) {
    return NextResponse.json(
      { success: false, error: "Server misconfigured: ABS_URL/ABS_TOKEN not set" },
      { status: 500 },
    );
  }

  try {
    const result = await syncAbsCache(absUrl, absToken);
    return NextResponse.json({ success: true, synced: result.synced });
  } catch (error) {
    console.error("ABS sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ABS sync failed" },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 2: Update `src/app/api/sync/goodreads/route.ts`**

```ts
import { NextResponse } from "next/server";
import { syncGoodreadsTbr } from "@/lib/goodreadsSync";
import { syncOwnedPhysicalBooks } from "@/lib/ownedPhysicalSync";

export async function POST() {
  const userId = process.env.GOODREADS_USER_ID;

  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Server misconfigured: GOODREADS_USER_ID not set" },
      { status: 500 },
    );
  }

  let synced = 0;
  const errors: string[] = [];

  try {
    const result = await syncGoodreadsTbr(userId);
    synced += result.synced;
  } catch (error) {
    console.error("Goodreads sync failed:", error);
    errors.push(error instanceof Error ? error.message : "Goodreads sync failed");
  }

  try {
    const shelfName = process.env.GOODREADS_OWNED_PHYSICAL_SHELF || undefined;
    const result = await syncOwnedPhysicalBooks(userId, shelfName);
    synced += result.synced;
  } catch (error) {
    console.error("Owned-physical sync failed:", error);
    errors.push(error instanceof Error ? error.message : "Owned-physical sync failed");
  }

  if (errors.length > 0) {
    return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 502 });
  }
  return NextResponse.json({ success: true, synced });
}
```

- [ ] **Step 3: Verify the project still typechecks/builds**

Run: `npm run build`
Expected: succeeds with no reference errors to `TBR_GAP_CACHE_TAG`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sync/abs/route.ts src/app/api/sync/goodreads/route.ts
git commit -m "refactor: drop revalidateTag from sync routes, no cache to invalidate"
```

---

### Task 6: `reconcileTbrItems` computes `owned` for new/changed shelf items

**Files:**
- Modify: `src/lib/goodreadsSync.ts`
- Test: `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/goodreadsSync.test.ts`, in the existing `describe` block that already tests `syncGoodreadsTbr`/`reconcileTbrItems` behavior (find the block covering shelf-item creation/update — follow this file's existing fixture conventions, e.g. mocking `fetch` for the RSS feed the same way neighboring tests do):

```ts
  it("sets owned:true on a newly-created shelf item that matches an existing owned Book", async () => {
    await prisma.book.create({ data: { title: "Test Goodreads Sync Owned Match" } });
    mockShelfFeed([
      { title: "Test Goodreads Sync Owned Match", author: "Someone", isbn: null, rating: null },
    ]);

    await syncGoodreadsTbr(TEST_USER_ID);

    const created = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync Owned Match" },
    });
    expect(created.owned).toBe(true);
  });

  it("sets owned:false on a newly-created shelf item with no matching owned Book", async () => {
    mockShelfFeed([
      { title: "Test Goodreads Sync Unowned New Item", author: "Someone", isbn: null, rating: null },
    ]);

    await syncGoodreadsTbr(TEST_USER_ID);

    const created = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync Unowned New Item" },
    });
    expect(created.owned).toBe(false);
  });

  it("recomputes owned when an existing item's title changes to match an owned Book", async () => {
    await prisma.book.create({ data: { title: "Test Goodreads Sync Retitled Match" } });
    const existing = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Goodreads Sync Old Title", author: "Someone", owned: false },
    });
    mockShelfFeed([
      { title: "Test Goodreads Sync Retitled Match", author: "Someone", isbn: null, rating: null },
    ]);

    await syncGoodreadsTbr(TEST_USER_ID);

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.title).toBe("Test Goodreads Sync Retitled Match");
    expect(updated.owned).toBe(true);
  });

  it("does not touch owned when an existing item's title is unchanged", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Goodreads Sync Unchanged Title", author: "Someone", owned: true },
    });
    mockShelfFeed([
      { title: "Test Goodreads Sync Unchanged Title", author: "Someone Else", isbn: null, rating: null },
    ]);

    await syncGoodreadsTbr(TEST_USER_ID);

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.author).toBe("Someone Else");
    expect(updated.owned).toBe(true);
  });
```

Note: `mockShelfFeed` and `TEST_USER_ID` are illustrative names — use whatever this test file's existing helper/constant for mocking the Goodreads RSS response and supplying a user id actually is (read the file's existing `syncGoodreadsTbr`/`reconcileTbrItems` tests immediately above the insertion point and match their exact setup pattern instead of introducing a new one).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- goodreadsSync.test.ts`
Expected: FAIL — `owned` is `undefined`/`false` where a test expects `true` (or a TS error if `owned` doesn't exist on the Prisma type yet — shouldn't happen since Task 1 already added it).

- [ ] **Step 3: Implement**

In `src/lib/goodreadsSync.ts`:

1. Add `isTitleMatch` to the existing matching import (line 5): `import { findBestTitleMatch, normalizeTitle, isTitleMatch } from "@/lib/matching";`

2. At the top of `reconcileTbrItems` (after the `existing` query, before the `existingByIsbn`/`existingByNormalizedTitle` setup), add:

```ts
  const ownedBooks = await prisma.book.findMany({ select: { title: true } });
  const ownedTitles = ownedBooks.map((b) => b.title);
```

3. Change the `toCreate` type declaration to include `owned`:

```ts
  const toCreate: { title: string; author: string | null; isbn: string | null; owned: boolean }[] = [];
```

4. In the create branch (`toCreate.push(...)`), compute `owned`:

```ts
    } else {
      toCreate.push({
        title: shelfItem.title,
        author: shelfItem.author,
        isbn: shelfItem.isbn,
        owned: ownedTitles.some((t) => isTitleMatch(shelfItem.title, t)),
      });
    }
```

5. In the update branch, only recompute `owned` when the title actually changed:

```ts
        await prisma.goodreadsTbrItem.update({
          where: { id: matched.id },
          data: {
            title: shelfItem.title,
            author: shelfItem.author,
            isbn: shelfItem.isbn,
            ...(matched.title !== shelfItem.title
              ? { owned: ownedTitles.some((t) => isTitleMatch(shelfItem.title, t)) }
              : {}),
            ...(isbnChanged && matched.coverImagePath === null
              ? { coverCheckedAt: null, coverFetchFailureReason: null }
              : {}),
          },
        });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- goodreadsSync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "feat: reconcileTbrItems computes owned for new/retitled shelf items"
```

---

### Task 7: Hook into `books.ts` — scan/add flow and edit page

**Files:**
- Modify: `src/lib/books.ts`
- Test: `src/lib/books.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/books.test.ts` (match its existing setup/cleanup conventions — see its `afterEach`):

```ts
describe("createBookWithCopyData ownership tracking", () => {
  afterEach(async () => {
    await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test Books Tbr" } } });
  });

  it("marks a matching unowned TBR item as owned when a brand-new Book is created", async () => {
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Books Tbr New Create Match", author: "Someone" },
    });

    await createBookWithCopyData({
      title: "Test Books Tbr New Create Match",
      author: "Someone",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(true);
  });
});

describe("updateBookData ownership tracking", () => {
  afterEach(async () => {
    await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test Books Tbr" } } });
  });

  it("marks a matching TBR item owned when a Book's title is edited to match it", async () => {
    const book = await prisma.book.create({ data: { title: "Test Books Tbr Old Edit Title" } });
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Books Tbr New Edit Title", author: "Someone" },
    });

    await updateBookData(book.id, {
      title: "Test Books Tbr New Edit Title",
      author: "",
      isbn: "",
    });

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(true);
  });

  it("unmarks a TBR item that was owned only via the old title, once the title is edited away", async () => {
    const book = await prisma.book.create({ data: { title: "Test Books Tbr Vanishing Title" } });
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Books Tbr Vanishing Title", author: "Someone", owned: true },
    });

    await updateBookData(book.id, {
      title: "Test Books Tbr Completely Different New Title",
      author: "",
      isbn: "",
    });

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(false);
  });

  it("does not touch TBR ownership when the title is unchanged", async () => {
    const book = await prisma.book.create({ data: { title: "Test Books Tbr Same Title" } });
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Books Tbr Same Title", author: "Someone", owned: true },
    });

    await updateBookData(book.id, { title: "Test Books Tbr Same Title", author: "New Author", isbn: "" });

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- books.test.ts`
Expected: FAIL — the new-book-creation test's TBR item stays `owned: false`; the edit-page tests likewise don't see the expected flip.

- [ ] **Step 3: Implement**

In `src/lib/books.ts`:

1. Add the import: `import { markTbrItemsOwnedByTitle, recheckOwnedTbrItems } from "@/lib/tbrGap";`

2. In `createBookWithCopyData`, right after the `const book = await prisma.book.create({...})` call (around line 133-140), before `return { bookId: book.id }`:

```ts
  const book = await prisma.book.create({
    data: {
      title,
      author: input.author.trim() || null,
      isbn,
      copies: { create: copyData },
    },
  });

  await markTbrItemsOwnedByTitle(title);

  return { bookId: book.id };
```

3. Rewrite `updateBookData` to fetch the old title first and only trigger the hooks when the title actually changes:

```ts
export async function updateBookData(
  bookId: string,
  input: { title: string; author: string; isbn: string },
): Promise<{ ok: true } | { error: string }> {
  const title = input.title.trim();
  if (!title) {
    return { error: "Title is required" };
  }

  const existing = await prisma.book.findUniqueOrThrow({
    where: { id: bookId },
    select: { title: true },
  });

  await prisma.book.update({
    where: { id: bookId },
    data: {
      title,
      author: input.author.trim() || null,
      isbn: normalizeIsbn(input.isbn) || null,
    },
  });

  if (existing.title !== title) {
    await recheckOwnedTbrItems();
    await markTbrItemsOwnedByTitle(title);
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- books.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/books.ts src/lib/books.test.ts
git commit -m "feat: hook TBR ownership tracking into book create/edit"
```

---

### Task 8: Hook into `absSync.ts` — create and delete-on-zero-copies

**Files:**
- Modify: `src/lib/absSync.ts`
- Test: `src/lib/absSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/absSync.test.ts`, matching its existing ABS-item-fixture/mocking conventions found in the neighboring `syncAbsCache` tests:

```ts
  it("marks a matching TBR item owned when a new Book is created from an ABS item", async () => {
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Abs Sync Tbr New Book Match", author: "Someone" },
    });
    mockAbsLibraryItems([
      { absItemId: "test-tbr-new-1", title: "Test Abs Sync Tbr New Book Match", author: "Someone", isbn: null },
    ]);

    await syncAbsCache(TEST_ABS_URL, TEST_ABS_TOKEN);

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(true);
  });

  it("unmarks a TBR item when its matching Book is deleted for having zero copies left", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Abs Sync Tbr Zero Copies",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-tbr-zero-1" } },
      },
    });
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Abs Sync Tbr Zero Copies", author: "Someone", owned: true },
    });
    mockAbsLibraryItems([]); // nothing seen this pass -> existing link goes stale -> book deleted

    await syncAbsCache(TEST_ABS_URL, TEST_ABS_TOKEN);

    await expect(prisma.book.findUnique({ where: { id: book.id } })).resolves.toBeNull();
    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(false);
  });
```

Note: `mockAbsLibraryItems`, `TEST_ABS_URL`, `TEST_ABS_TOKEN` are illustrative — use this file's actual existing fixture/mock helpers (read the tests immediately surrounding `createBookForItem`/`removeStaleAbsLinks` coverage already in this file and match their exact setup).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- absSync.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

In `src/lib/absSync.ts`:

1. Add the import: `import { markTbrItemsOwnedByTitle, recheckOwnedTbrItems } from "@/lib/tbrGap";`

2. In the main sync loop (around line 469-476), mark ownership right after a new book is created:

```ts
    try {
      const match = findBestTitleMatch(books, item.title);
      if (match) {
        await linkItemToExistingBook(match, mediaType, item.absItemId);
      } else {
        const created = await createBookForItem(item, mediaType);
        books.push(created);
        await markTbrItemsOwnedByTitle(created.title);
      }
    } catch (err) {
      if (!isConcurrentAbsItemLink(err)) throw err;
    }
```

3. In `removeStaleAbsLinks`, track whether any book was actually deleted and recheck once at the end:

```ts
  if (affectedBookIds.size === 0) return;
  const affectedIds = Array.from(affectedBookIds);

  // ...existing groupBy Promise.all block unchanged...

  let anyBookDeleted = false;

  for (const bookId of affectedIds) {
    const ebookCount = ebookCounts.get(bookId) ?? 0;
    const audiobookCount = audiobookCounts.get(bookId) ?? 0;
    const physicalCount = physicalCounts.get(bookId) ?? 0;

    if (ebookCount === 0 && audiobookCount === 0 && physicalCount === 0) {
      await prisma.book.delete({ where: { id: bookId } });
      anyBookDeleted = true;
      continue;
    }

    await prisma.book.update({
      where: { id: bookId },
      data: {
        hasEbook: ebookCount > 0,
        hasAudiobook: audiobookCount > 0,
        lastAbsSyncedAt: new Date(),
      },
    });
  }

  if (anyBookDeleted) {
    await recheckOwnedTbrItems();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- absSync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/absSync.ts src/lib/absSync.test.ts
git commit -m "feat: hook TBR ownership tracking into ABS sync create/delete"
```

---

### Task 9: Hook into `ownedPhysicalSync.ts` — new-book creation

**Files:**
- Modify: `src/lib/ownedPhysicalSync.ts`
- Test: `src/lib/ownedPhysicalSync.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/ownedPhysicalSync.test.ts`, matching its existing fixture conventions:

```ts
  it("marks a matching TBR item owned when a new Book is created from the owned-physical shelf", async () => {
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Owned Physical Tbr New Match", author: "Someone" },
    });
    mockOwnedPhysicalShelf([
      { title: "Test Owned Physical Tbr New Match", author: "Someone", isbn: null, rating: null },
    ]);

    await syncOwnedPhysicalBooks(TEST_USER_ID);

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(true);
  });
```

Note: `mockOwnedPhysicalShelf`/`TEST_USER_ID` are illustrative — match this file's actual existing shelf-fetch mocking convention.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ownedPhysicalSync.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

In `src/lib/ownedPhysicalSync.ts`:

1. Add the import: `import { markTbrItemsOwnedByTitle } from "@/lib/tbrGap";`

2. Right after the `const created = await prisma.book.create({...})` call (around line 117-126), before `candidates.push(toCandidate(created))`:

```ts
  const created = await prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      isbn: item.isbn,
      copies: { create: { format: "OTHER" } },
    },
    select: CANDIDATE_SELECT,
  });
  await markTbrItemsOwnedByTitle(item.title);
  candidates.push(toCandidate(created));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ownedPhysicalSync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ownedPhysicalSync.ts src/lib/ownedPhysicalSync.test.ts
git commit -m "feat: hook TBR ownership tracking into owned-physical sync"
```

---

### Task 10: Hook into `duplicates.ts` — merge deletion

**Files:**
- Modify: `src/lib/duplicates.ts`
- Test: `src/lib/duplicates.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/duplicates.test.ts`, near the existing merge tests:

```ts
  it("rechecks TBR ownership after a merge deletes a losing book", async () => {
    const keep = await prisma.book.create({ data: { title: "Test Duplicates Tbr Keep Book" } });
    const merge = await prisma.book.create({ data: { title: "Test Duplicates Tbr Merge Book" } });
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Duplicates Tbr Merge Book", author: "Someone", owned: true },
    });

    await mergeBooksData(keep.id, [merge.id]);

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- duplicates.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

In `src/lib/duplicates.ts`:

1. Add the import: `import { recheckOwnedTbrItems } from "@/lib/tbrGap";`

2. Right after the `await prisma.$transaction([...])` call (around line 300-318), before `return { ok: true }`:

```ts
  await prisma.$transaction([
    prisma.physicalCopy.updateMany({ where: { bookId: { in: mergeIds } }, data: { bookId: keepId } }),
    prisma.ebookCopy.updateMany({ where: { bookId: { in: mergeIds } }, data: { bookId: keepId } }),
    prisma.audiobookCopy.updateMany({ where: { bookId: { in: mergeIds } }, data: { bookId: keepId } }),
    prisma.book.update({ where: { id: keepId }, data: { hasEbook, hasAudiobook } }),
    prisma.book.deleteMany({ where: { id: { in: mergeIds } } }),
  ]);

  await recheckOwnedTbrItems();

  return { ok: true };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- duplicates.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/duplicates.ts src/lib/duplicates.test.ts
git commit -m "feat: hook TBR ownership tracking into duplicate-book merge"
```

---

### Task 11: Hook into `copies.ts` — last-copy deletion

**Files:**
- Modify: `src/lib/copies.ts`
- Test: `src/lib/copies.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/copies.test.ts`, near existing `deleteCopyData` tests:

```ts
  it("rechecks TBR ownership when deleting the last copy deletes the Book", async () => {
    const book = await prisma.book.create({
      data: { title: "Test Copies Tbr Last Copy", copies: { create: { format: "PAPERBACK" } } },
    });
    const copy = await prisma.physicalCopy.findFirstOrThrow({ where: { bookId: book.id } });
    const tbrItem = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Copies Tbr Last Copy", author: "Someone", owned: true },
    });

    const result = await deleteCopyData(copy.id);

    expect(result.bookDeleted).toBe(true);
    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbrItem.id } });
    expect(updated.owned).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- copies.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

In `src/lib/copies.ts`:

1. Add the import: `import { recheckOwnedTbrItems } from "@/lib/tbrGap";`

2. In `deleteCopyData`, after the `prisma.book.delete` call:

```ts
    if (!book.hasEbook && !book.hasAudiobook) {
      await prisma.book.delete({ where: { id: copy.bookId } });
      await recheckOwnedTbrItems();
      return { bookId: copy.bookId, bookDeleted: true };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- copies.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/copies.ts src/lib/copies.test.ts
git commit -m "feat: hook TBR ownership tracking into last-copy deletion"
```

---

### Task 12: One-time backfill script for existing rows

**Files:**
- Create: `scripts/backfill-tbr-owned.ts`
- Modify: `package.json`

This is a one-time operational script, not application code — it computes the correct initial `owned` value for every `GoodreadsTbrItem` row that existed before this feature shipped (all default to `owned: false` from the migration in Task 1, which is wrong for any that are actually already owned). It must be run once, manually, against each real environment (dev DB and production) after this branch's migration has been applied there — it is NOT run automatically by any deploy step, sync, or test.

- [ ] **Step 1: Add `tsx` as a dev dependency**

Run: `npm install --save-dev tsx`

This is the only practical way to run a one-off TypeScript file that uses this project's `@/` path alias (which plain `node` can't resolve) without introducing a build step — `tsx` resolves `tsconfig.json`'s `paths` automatically.

- [ ] **Step 2: Add a package.json script**

In `package.json`'s `"scripts"` block, add:

```json
    "backfill:tbr-owned": "tsx scripts/backfill-tbr-owned.ts"
```

- [ ] **Step 3: Write the script**

Create `scripts/backfill-tbr-owned.ts`:

```ts
// One-time backfill: computes the correct `owned` value for every
// GoodreadsTbrItem that existed before the owned-flag migration (which
// defaults every row to `owned: false`). Run once per environment after
// deploying that migration -- see docs/superpowers/plans/2026-07-25-tbr-ownership-tracking.md.
// Not invoked automatically by any application code, sync, or test.
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";

async function main() {
  const [tbrItems, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({ select: { id: true, title: true } }),
    prisma.book.findMany({ select: { title: true } }),
  ]);
  const ownedTitles = books.map((b) => b.title);

  let updated = 0;
  for (const item of tbrItems) {
    const owned = ownedTitles.some((title) => isTitleMatch(item.title, title));
    if (owned) {
      await prisma.goodreadsTbrItem.update({ where: { id: item.id }, data: { owned: true } });
      updated++;
    }
  }

  console.log(`Backfilled ownership: ${updated}/${tbrItems.length} TBR items marked owned.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 4: Verify against the dev database**

Run: `npm run backfill:tbr-owned`
Expected: prints `Backfilled ownership: N/M TBR items marked owned.` with real counts, no errors. Spot-check by loading `/tbr` in a dev server afterward and confirming no book you already own still appears in the gap list.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-tbr-owned.ts package.json package-lock.json
git commit -m "chore: add one-time TBR ownership backfill script"
```

- [ ] **Step 6: Document the production rollout step**

This step has no code change — it's a reminder for whoever deploys this branch: after the migration from Task 1 has been applied to the production database, run `npm run backfill:tbr-owned` once against production (e.g. via an EasyPanel shell into the running container, or any other path that reaches the production `DATABASE_URL`) before considering this feature fully live. Until that runs, every pre-existing TBR item will show as unowned regardless of its real status, even though all the incremental hooks from Tasks 6-11 will correctly maintain the flag for anything that changes going forward.

---

### Task 13: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all test files pass, including every file touched in Tasks 2-12.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: succeeds with no type errors (confirms no leftover references to `TBR_GAP_CACHE_TAG`, `unstable_cache`, or the old `computeTbrGap` signature anywhere).

- [ ] **Step 3: Run the linter**

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Manual smoke check against the real dev database**

Start the dev server (`npm run dev`), load `/tbr`, and confirm:
- The page loads near-instantly (no multi-second wait), both cold (first load) and after clicking "Refresh now" on the home page.
- The gap list still looks correct (books you don't own appear; books you do own don't) — this depends on Task 12's backfill having already been run against the dev DB.

Use the same session-minting-via-Playwright approach documented in this project's prior performance investigation if browser automation is needed rather than manual clicking.
