# Cover-Fetch Race Guard + ISBN Search Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two independent, narrow gaps: (1) a cron/manual-refresh cover-fetch race that can silently orphan a cover file on disk (backlog #9), and (2) ISBN-shaped queries not matching in `/tbr`'s own search, the autocomplete `home`/`books` scopes, or (by extension) the autocomplete `tbr` scope (backlog #14, extended).

**Architecture:** Part 1 (race guard) changes `fetchMissingTbrCovers` (`goodreadsSync.ts`) and `backfillAbsCovers` (`absSync.ts`) from a blind `update` to an optimistic-concurrency `updateMany({ where: { id, coverCheckedAt: null } })`, checking the returned count to detect a lost race and clean up an unreferenced file. Part 2 (ISBN matching) threads the same `looksLikeIsbnQuery`/`normalizeIsbn` pattern `search.ts` already uses into `tbrGap.ts`'s `getTbrGap` and the autocomplete route's `home`/`books` branch; the autocomplete `tbr` scope inherits the fix for free since it already delegates to `getTbrGap`.

**Tech Stack:** Next.js App Router, Prisma, TypeScript, Vitest with a real isolated Postgres test DB.

---

## Design spec

Full rationale: `docs/superpowers/specs/2026-07-19-cover-race-and-isbn-search-design.md`. Read it before starting.

## Task 1: Optimistic concurrency guard — TBR cover fetch

**Files:**
- Modify: `src/lib/goodreadsSync.ts` (`fetchMissingTbrCovers`)
- Test: `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/goodreadsSync.test.ts`, add `readdir` to the existing `node:fs/promises` import (currently `import { readFile } from "node:fs/promises";`):

```typescript
import { readFile, readdir } from "node:fs/promises";
```

Then, inside `describe("syncGoodreadsTbr", ...)`, add this test right after the existing `"fetches and stores a cover for a new TBR item that has an ISBN"` test:

```typescript
  it("cleans up its own saved file when a concurrent run claims the row first", async () => {
    // Simulates the cron and a manual "Refresh now" overlapping: another
    // process's write lands between this run's cover fetch and its own
    // guarded update, so the optimistic guard must back off and this run's
    // own newly-saved file must not be left orphaned on disk.
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780000000199-M.jpg",
    });
    mockShelfFetch({
      "to-read": [
        buildRssPage([{ title: "Test Goodreads Sync Race Book", isbn13: "9780000000199" }]),
      ],
    });
    const rssFetch = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("covers.openlibrary.org")) {
        // Simulate a concurrent run winning the race and claiming this
        // row's coverCheckedAt first -- right before fetchMissingTbrCovers
        // reaches its own guarded update for the item reconcileTbrItems
        // already created earlier in this same sync call.
        const existing = await prisma.goodreadsTbrItem.findFirstOrThrow({
          where: { title: "Test Goodreads Sync Race Book" },
        });
        await prisma.goodreadsTbrItem.update({
          where: { id: existing.id },
          data: { coverCheckedAt: new Date("2020-01-01T00:00:00.000Z") },
        });
        return {
          ok: true,
          type: "basic",
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: async () =>
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
        } as unknown as Response;
      }
      return rssFetch(input as never);
    }) as typeof global.fetch;
    const filesBefore = new Set(await readdir(uploadsDir));

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync Race Book" },
    });
    // The competing write's value stands -- this run's own guarded update
    // must have seen coverCheckedAt no longer null and backed off.
    expect(updated.coverCheckedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(updated.coverImagePath).toBeNull();
    const filesAfter = await readdir(uploadsDir);
    expect(filesAfter.filter((f) => !filesBefore.has(f))).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "concurrent run claims the row first"`

Expected: FAIL — `updated.coverImagePath` is NOT null (the current unconditional `update` overwrites the competing write, saving the file's path even though another run already claimed the row), and/or a new file remains in `uploadsDir` after the run.

- [ ] **Step 3: Implement the guard**

In `src/lib/goodreadsSync.ts`, inside `fetchMissingTbrCovers`, replace the per-item update:

```typescript
    await prisma.goodreadsTbrItem.update({
      where: { id: item.id },
      data: {
        coverCheckedAt: new Date(),
        coverFetchFailureReason: failureReason,
        ...(coverImagePath ? { coverImagePath } : {}),
      },
    });
```

with:

```typescript
    // Optimistic guard: only write if this row still has coverCheckedAt ===
    // null, i.e. no concurrent run (the cron and a manual "Refresh now"
    // overlapping) already claimed it first. If we lost the race, the other
    // run's write already stands as this row's authoritative state -- any
    // cover file we just saved is now unreferenced and must be cleaned up,
    // not left orphaned on disk.
    const { count } = await prisma.goodreadsTbrItem.updateMany({
      where: { id: item.id, coverCheckedAt: null },
      data: {
        coverCheckedAt: new Date(),
        coverFetchFailureReason: failureReason,
        ...(coverImagePath ? { coverImagePath } : {}),
      },
    });
    if (count === 0 && coverImagePath) {
      await deleteCoverImage(coverImagePath);
    }
```

`deleteCoverImage` is already imported in this file (`import { deleteCoverImage } from "@/lib/coverStorage";`) — no new import needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`

Expected: all tests in this file pass, including every pre-existing cover-fetch test (the normal, no-race path must behave identically — `updateMany` with `count: 1` is functionally equivalent to the old `update` when nothing else touched the row).

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "fix: guard fetchMissingTbrCovers's update against a concurrent race

fetchMissingTbrCovers read pending rows, then unconditionally wrote
coverCheckedAt/coverImagePath -- if the cron and a manual 'Refresh
now' overlapped, both could fetch+save a cover for the same row, and
whichever update landed second would silently overwrite the first's
result with no cleanup of the loser's now-unreferenced file. Changed
to an optimistic updateMany({ where: { id, coverCheckedAt: null } }):
a count of 0 means another run already claimed the row, so this run's
own saved file (if any) is deleted instead of left orphaned."
```

## Task 2: Optimistic concurrency guard — ABS cover fetch

**Files:**
- Modify: `src/lib/absSync.ts` (`backfillAbsCovers`)
- Test: `src/lib/absSync.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/absSync.test.ts`, add `readdir` to the existing `node:fs/promises` import (currently `import { readFile } from "node:fs/promises";`):

```typescript
import { readFile, readdir } from "node:fs/promises";
```

Then, inside `describe("syncAbsCache", ...)`, add this test right after the existing `"backfills a cover for an existing EbookCopy missing one"` test:

```typescript
  it("cleans up its own saved file when a concurrent run claims the row first", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Race Winner Elsewhere",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "race-ebook-1" } },
      },
    });
    const copy = await prisma.ebookCopy.findFirstOrThrow({
      where: { absItemId: "race-ebook-1" },
    });

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/libraries")) {
        return { ok: true, json: async () => ({ libraries: [] }) } as Response;
      }
      if (url.includes("/api/items/race-ebook-1/cover")) {
        // Simulate a concurrent run (e.g. the cron and a manual "Refresh
        // now" overlapping) winning the race and claiming this row first,
        // right before this run's own guarded update executes.
        await prisma.ebookCopy.update({
          where: { id: copy.id },
          data: { coverCheckedAt: new Date("2020-01-01T00:00:00.000Z") },
        });
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: async () =>
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof global.fetch;
    const filesBefore = new Set(await readdir(uploadsDir));

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.ebookCopy.findFirstOrThrow({ where: { id: copy.id } });
    expect(updated.coverCheckedAt?.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(updated.coverImagePath).toBeNull();
    const filesAfter = await readdir(uploadsDir);
    expect(filesAfter.filter((f) => !filesBefore.has(f))).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/absSync.test.ts -t "concurrent run claims the row first"`

Expected: FAIL — same failure shape as Task 1's test (the competing write gets overwritten, and/or an orphaned file remains).

- [ ] **Step 3: Implement the guard**

In `src/lib/absSync.ts`, inside `backfillAbsCovers`, replace the per-copy update block:

```typescript
  for (const copy of pending) {
    const result = await fetchAbsCoverAndSave(baseUrl, token, copy.absItemId);
    const data = {
      coverCheckedAt: new Date(),
      ...("coverImagePath" in result
        ? { coverImagePath: result.coverImagePath, coverFetchFailureReason: null }
        : { coverFetchFailureReason: result.reason ?? null }),
    };
    if (copy.table === "ebook") {
      await prisma.ebookCopy.update({ where: { id: copy.id }, data });
    } else {
      await prisma.audiobookCopy.update({ where: { id: copy.id }, data });
    }
  }
```

with:

```typescript
  for (const copy of pending) {
    const result = await fetchAbsCoverAndSave(baseUrl, token, copy.absItemId);
    const data = {
      coverCheckedAt: new Date(),
      ...("coverImagePath" in result
        ? { coverImagePath: result.coverImagePath, coverFetchFailureReason: null }
        : { coverFetchFailureReason: result.reason ?? null }),
    };
    // Optimistic guard: only write if this row still has coverCheckedAt ===
    // null -- see the identical rationale in fetchMissingTbrCovers
    // (goodreadsSync.ts).
    const updateResult =
      copy.table === "ebook"
        ? await prisma.ebookCopy.updateMany({
            where: { id: copy.id, coverCheckedAt: null },
            data,
          })
        : await prisma.audiobookCopy.updateMany({
            where: { id: copy.id, coverCheckedAt: null },
            data,
          });
    if (updateResult.count === 0 && "coverImagePath" in result) {
      await deleteCoverImage(result.coverImagePath);
    }
  }
```

`deleteCoverImage` is already imported in this file (`import { deleteCoverImage, saveCoverImage, UnsupportedCoverFormatError } from "@/lib/coverStorage";`) — no new import needed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/absSync.test.ts`

Expected: all tests in this file pass, including every pre-existing cover-fetch/backfill test (interleaving, unsupported-format, retry-clears-reason, never-re-attempts).

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/lib/absSync.ts src/lib/absSync.test.ts`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/absSync.ts src/lib/absSync.test.ts
git commit -m "fix: guard backfillAbsCovers's update against a concurrent race

Same fix as fetchMissingTbrCovers (goodreadsSync.ts, prior commit):
changed the per-copy update to an optimistic
updateMany({ where: { id, coverCheckedAt: null } }), cleaning up this
run's own saved cover file when the returned count is 0 (another
concurrent run already claimed the row first) instead of leaving it
orphaned on disk."
```

## Task 3: ISBN matching in tbrGap.ts

**Files:**
- Modify: `src/lib/tbrGap.ts`
- Test: `src/lib/tbrGap.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/tbrGap.test.ts`, inside `describe("getTbrGap", ...)`, add these three tests right after the existing `"filters by a case-insensitive author match when a query is given"` test:

```typescript
  it("matches by ISBN when the query is ISBN-shaped, even if title/author don't contain it", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Isbn Match Book", author: "Someone", isbn: "9780765326355" },
    });

    const gap = await getTbrGap("9780765326355");

    expect(gap.some((item) => item.title === "Test TBR Isbn Match Book")).toBe(true);
  });

  it("matches by ISBN through hyphens in the query, via normalization", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Isbn Hyphen Book", author: "Someone", isbn: "9780765326355" },
    });

    const gap = await getTbrGap("978-0-7653-2635-5");

    expect(gap.some((item) => item.title === "Test TBR Isbn Hyphen Book")).toBe(true);
  });

  it("does not match an ISBN-shaped query against an unrelated item's isbn", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Isbn No Match Book", author: "Someone", isbn: "9780000000001" },
    });

    const gap = await getTbrGap("9780000000099");

    expect(gap.some((item) => item.title === "Test TBR Isbn No Match Book")).toBe(false);
  });
```

Then, inside `describe("groupByInitial", ...)`, update the local `item()` helper (currently `function item(title: string, author: string | null): TbrGapItem { return { id: title, title, author, coverImagePath: null }; }`) to include the new field:

```typescript
  function item(title: string, author: string | null): TbrGapItem {
    return { id: title, title, author, coverImagePath: null, isbn: null };
  }
```

(This is a required fix, not optional — `TbrGapItem` is gaining a new non-optional `isbn` field in Step 3 below, so this helper's return type would otherwise fail to typecheck. Every existing call site of `item(...)` in this describe block stays exactly as-is; only the helper's own return object changes.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/tbrGap.test.ts`

Expected: FAIL — the three new ISBN tests fail (no ISBN matching exists yet), and depending on TypeScript's exact checking order the file may not even compile yet since `isbn` isn't on `TbrGapItem` — that's fine, both are expected failure modes at this point.

- [ ] **Step 3: Implement ISBN matching**

In `src/lib/tbrGap.ts`, add the import:

```typescript
import { normalizeIsbn } from "@/lib/books";
```

Add `isbn: string | null` to the `TbrGapItem` interface:

```typescript
export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
  coverImagePath: string | null;
  isbn: string | null;
}
```

In `computeTbrGap`, add `isbn: true` to the `goodreadsTbrItem.findMany` select, and `isbn: tbr.isbn` to the mapped object:

```typescript
async function computeTbrGap(): Promise<TbrGapItem[]> {
  const [tbrItems, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({
      select: { id: true, title: true, author: true, coverImagePath: true, isbn: true },
    }),
    prisma.book.findMany({ select: { title: true } }),
  ]);

  const ownedTitles = books.map((b) => b.title);

  return tbrItems
    .filter((tbr) => !ownedTitles.some((owned) => isTitleMatch(tbr.title, owned)))
    .map((tbr) => ({
      id: tbr.id,
      title: tbr.title,
      author: tbr.author,
      coverImagePath: tbr.coverImagePath,
      isbn: tbr.isbn,
    }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: "base" }));
}
```

In `getTbrGap`, add the ISBN branch to the filter:

```typescript
export async function getTbrGap(query?: string): Promise<TbrGapItem[]> {
  const gap = process.env.NODE_ENV === "test" ? await computeTbrGap() : await getCachedTbrGap();

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/tbrGap.test.ts`

Expected: all tests pass, including every pre-existing `getTbrGap`/`groupByInitial` test.

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/lib/tbrGap.ts src/lib/tbrGap.test.ts`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tbrGap.ts src/lib/tbrGap.test.ts
git commit -m "feat: match ISBN in getTbrGap, mirroring search.ts's existing pattern

/tbr's own search never matched ISBN at all, unlike searchCatalog and
/books' own query -- closes backlog item #14's extended scope. TbrGapItem
gains an isbn field (selected but previously unused); getTbrGap's filter
gets an ISBN branch reusing the same looksLikeIsbnQuery/normalizeIsbn
pattern already established in search.ts."
```

## Task 4: ISBN matching in autocomplete + /tbr placeholder text

**Files:**
- Modify: `src/app/api/autocomplete/route.ts`
- Modify: `src/app/tbr/page.tsx`
- Test: `src/app/api/autocomplete/route.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/app/api/autocomplete/route.test.ts`, add these two tests right after the existing `"matches on author as well as title"` test:

```typescript
  it("matches on ISBN for the home scope, even when title/author don't contain the query", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Isbn Book", author: "Someone", isbn: "9780765326355" },
    });

    const response = await GET(makeRequest({ scope: "home", q: "9780765326355" }));
    const data = await response.json();

    expect(data.map((s: { title: string }) => s.title)).toContain("Test Autocomplete Isbn Book");
  });

  it("matches on ISBN for the books scope", async () => {
    await prisma.book.create({
      data: {
        title: "Test Autocomplete Isbn Books Scope",
        author: "Someone",
        isbn: "9780000000188",
      },
    });

    const response = await GET(makeRequest({ scope: "books", q: "9780000000188" }));
    const data = await response.json();

    expect(data.map((s: { title: string }) => s.title)).toContain(
      "Test Autocomplete Isbn Books Scope",
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/autocomplete/route.test.ts -t "matches on ISBN"`

Expected: FAIL — the route's `home`/`books` branch doesn't match ISBN yet.

- [ ] **Step 3: Implement ISBN matching in the route**

In `src/app/api/autocomplete/route.ts`, add the import:

```typescript
import { normalizeIsbn } from "@/lib/books";
```

Replace `fetchSuggestions`'s `home`/`books` branch:

```typescript
  return prisma.book.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { title: true, author: true },
    take: SUGGESTION_LIMIT,
    orderBy: { title: "asc" },
  });
```

with:

```typescript
  // Mirrors search.ts's isbn-shaped-query detection so this scope matches
  // the same way searchCatalog and /books' own query already do.
  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(q);
  const normalizedIsbnQuery = looksLikeIsbnQuery ? normalizeIsbn(q) : "";

  return prisma.book.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
        ...(normalizedIsbnQuery
          ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
          : []),
      ],
    },
    select: { title: true, author: true },
    take: SUGGESTION_LIMIT,
    orderBy: { title: "asc" },
  });
```

The `"tbr"` branch above this (the early `if (scope === "tbr") { ... }` block) needs no change — it already delegates to `getTbrGap(q)`, which gained ISBN matching in Task 3.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/api/autocomplete/route.test.ts`

Expected: all tests pass, including every pre-existing autocomplete test.

- [ ] **Step 5: Update the /tbr placeholder text**

In `src/app/tbr/page.tsx`, change:

```tsx
          placeholder="Search by title or author"
```

to:

```tsx
          placeholder="Search by title, author, or ISBN"
```

(Matching `/books`' existing wording exactly — no other change to this file.)

- [ ] **Step 6: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/app/api/autocomplete/route.ts src/app/api/autocomplete/route.test.ts src/app/tbr/page.tsx`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/autocomplete/route.ts src/app/api/autocomplete/route.test.ts src/app/tbr/page.tsx
git commit -m "feat: match ISBN in autocomplete's home/books scopes, update /tbr placeholder

Closes backlog item #14: the autocomplete home/books branch only
matched title/author, unlike searchCatalog and /books' own query --
now reuses the same isbn-shaped-query pattern. The tbr scope needed no
code change here since it already delegates to getTbrGap, which
gained ISBN matching in the prior commit. /tbr's own search box
placeholder now reads 'Search by title, author, or ISBN', matching
/books' existing wording, since /tbr's search (getTbrGap) now actually
supports it."
```

## Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `npx tsc --noEmit`, `npx eslint .`, `npm test`

Expected: all clean, all passing (aside from the two pre-existing, unrelated findings in `CoverPicker.tsx`/`copies.ts` — confirm they still predate this branch, same as every prior phase this session).

- [ ] **Step 2: Manual browser verification**

This app has no automated Next.js page-rendering tests, so this step is the real verification for the ISBN-search UI changes (Task 4's placeholder text and the end-to-end autocomplete/`/tbr` search experience), per this project's standing practice for UI changes.

Start the dev server (`npm run dev`) against this worktree, then use Playwright (or the Playwright MCP tool) to:

1. Seed (via direct Prisma insert, since the local dev DB has no realistic data — see the project-phases memory note on this) a `GoodreadsTbrItem` row with a real ISBN and a title/author that don't contain any part of that ISBN, that is NOT owned by any `Book` (so it appears in the TBR gap).
2. Navigate to `/tbr`. Confirm the search box's placeholder now reads "Search by title, author, or ISBN". Type the seeded item's ISBN into the search box and submit; confirm the item appears in the results (it wouldn't have, before this phase).
3. Type the same ISBN into the home page's search box (autocomplete `home` scope) and confirm a dropdown suggestion appears for a `Book` with that ISBN (seed one via direct Prisma insert if the dev DB doesn't already have a matching one) — confirm no dropdown appeared for an ISBN query before this phase's autocomplete fix, if easy to check by temporarily reverting, otherwise just confirm the current (fixed) behavior directly.
4. Clean up any seeded test rows afterward.

If anything in this walkthrough reveals a bug, fix it (with a matching automated test if the bug is at the data/query layer) before considering this task done.

- [ ] **Step 3: Report**

Confirm all steps above passed. This is the last task in the plan.

## Non-goals (do not implement)

- No change to `searchCatalog`/`/books`' own ISBN matching — already correct, used as the reference pattern only.
- No change to the cover-fetch caps (`TBR_COVER_FETCH_CAP`, `ABS_COVER_FETCH_CAP`) or retry cadence.
- No locking/transaction changes beyond the per-row optimistic guard — this doesn't need to prevent concurrent runs from starting, only to prevent a lost update's file from leaking.
- No UI change to the ISBN behavior itself beyond the `/tbr` placeholder text — matching results were already rendered correctly wherever they already matched by title/author; this only widens what counts as a match.
