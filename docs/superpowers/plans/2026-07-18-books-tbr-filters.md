# Filters on /books and /tbr Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `/books` (Manage Physical Books) up to parity with the home page's status/rating filter, and give `/tbr` (TBR gap view) a search box plus an alphabetical jump list.

**Architecture:** Extract the home page's inline status-filter Prisma-where-building logic out of `searchCatalog` into a standalone exported function so `/books` can reuse it without duplication. Extend `tbrGap.ts`'s existing cached-computation pattern with a sort key, an in-memory query filter applied after the cache lookup, and a pure grouping helper — all unit-tested at the `lib` layer, matching this codebase's existing convention of untested, thin page components.

**Tech Stack:** Next.js App Router (Server Components, GET-form query params, no client JS), Prisma, Vitest (real dev Postgres, no mocks — matches every existing `.test.ts` in this repo).

---

### Task 1: Extract `buildStatusWhere` from `searchCatalog`

**Files:**
- Modify: `src/lib/search.ts`
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/search.test.ts` (new `describe` block, alongside the existing `searchCatalog` one — these are pure unit tests, no DB needed, so they don't need an `afterEach` entry):

```ts
import { buildStatusWhere } from "@/lib/search";
```

(add `buildStatusWhere` to the existing `import { searchCatalog, parseFormatParam, ... } from "@/lib/search";` line)

```ts
describe("buildStatusWhere", () => {
  it("returns undefined when no status values are given", () => {
    expect(buildStatusWhere(undefined, "or")).toBeUndefined();
  });

  it("returns undefined for an empty status array", () => {
    expect(buildStatusWhere([], "or")).toBeUndefined();
  });

  it("builds an OR clause of readStatus/rating conditions for 'or' mode", () => {
    const where = buildStatusWhere(["reading", "unrated"], "or");
    expect(where).toEqual({
      OR: [{ readStatus: "READING" }, { rating: null }],
    });
  });

  it("builds an AND clause of readStatus/rating conditions for 'and' mode", () => {
    const where = buildStatusWhere(["read", "unrated"], "and");
    expect(where).toEqual({
      AND: [{ readStatus: "READ" }, { rating: null }],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- search.test.ts`
Expected: FAIL — `buildStatusWhere` is not exported from `src/lib/search.ts`.

- [ ] **Step 3: Extract the function**

In `src/lib/search.ts`, add this new exported function (place it after `parseStatusModeParam` and before `searchCatalog`):

```ts
export function buildStatusWhere(
  statusValues: ReadStatusFilterValue[] | undefined,
  statusMode: StatusFilterMode,
): Prisma.BookWhereInput | undefined {
  if (!statusValues || statusValues.length === 0) return undefined;
  const statusConditions: Prisma.BookWhereInput[] = statusValues.map((value) =>
    value === "unrated" ? { rating: null } : { readStatus: STATUS_VALUE_TO_ENUM[value] },
  );
  return statusMode === "and" ? { AND: statusConditions } : { OR: statusConditions };
}
```

Then replace the inline block inside `searchCatalog`:

```ts
  if (statusValues) {
    const statusConditions: Prisma.BookWhereInput[] = statusValues.map((value) =>
      value === "unrated" ? { rating: null } : { readStatus: STATUS_VALUE_TO_ENUM[value] },
    );
    // "and" is meaningful when combining a status with "unrated" (e.g.
    // "reading AND unrated"); ANDing two distinct readStatus values together
    // isn't a separate case to guard against -- a Book's readStatus is a
    // single column, so requiring it to equal two different values at once
    // naturally (and correctly) matches nothing at the SQL level, with no
    // special-casing needed here.
    const statusMode = options.statusMode ?? "or";
    filters.push(statusMode === "and" ? { AND: statusConditions } : { OR: statusConditions });
  }
```

with:

```ts
  const statusWhere = buildStatusWhere(statusValues, options.statusMode ?? "or");
  if (statusWhere) filters.push(statusWhere);
```

(The comment about "and" semantics for `unrated` moves with the logic — put it directly above the new `buildStatusWhere` function instead, since that's now where the AND/OR decision actually lives.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- search.test.ts`
Expected: PASS — the new `buildStatusWhere` tests pass, and every existing `searchCatalog` status/statusMode test (lines ~240-360 in the original file) still passes unchanged, proving the extraction didn't change behavior.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "refactor: extract buildStatusWhere from searchCatalog for reuse on /books"
```

---

### Task 2: Add status/rating filter to `/books`

**Files:**
- Modify: `src/app/books/page.tsx`

**Context:** `/books` currently builds its Prisma `where` clause as a flat spread object:

```ts
const books = await prisma.book.findMany({
    where: {
      ...(query ? { OR: [...] } : {}),
      ...(format ? { copies: { some: { format } } } : {}),
    },
    include: { copies: true },
    orderBy: { title: "asc" },
  });
```

Adding a status filter here matters more than it looks: `buildStatusWhere` can itself return a top-level `{ OR: [...] }` object (when `statusMode` is `"or"`, the default). Spreading that into the *same* object as the query-text `{ OR: [...] }` would silently overwrite one `OR` key with the other via plain object spread — a real bug, not a style nit. This task also restructures the `where` construction to use an explicit `filters: Prisma.BookWhereInput[]` array combined via `{ AND: filters }`, the same pattern `searchCatalog` already uses in `src/lib/search.ts`, which avoids the collision entirely.

No new `lib` test is needed for this task — `buildStatusWhere` is already fully unit-tested (Task 1), and this codebase has no page-level (`.tsx`) tests anywhere (verified: `find src/app -name "*.test.ts*"` returns nothing). Verify by reading the diff carefully and running the dev server (Step 3).

- [ ] **Step 1: Update `src/app/books/page.tsx`**

Replace the full file with:

```tsx
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import {
  parseFormatParam,
  parseStatusParam,
  parseStatusModeParam,
  buildStatusWhere,
} from "@/lib/search";
import { normalizeIsbn } from "@/lib/books";
import { FORMAT_OPTIONS } from "@/components/CopyFormFields";
import { STATUS_FILTER_OPTIONS } from "@/components/ReadingProgressFields";

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    format?: string;
    status?: string | string[];
    statusMode?: string;
  }>;
}) {
  const {
    q,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
  } = await searchParams;
  const query = q?.trim() || "";
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);

  // Book.isbn is always stored normalized (digits + uppercase X only, no
  // hyphens/spaces) -- mirror the same isbn-shaped guard + normalization
  // searchCatalog (src/lib/search.ts) already uses, so a hyphenated ISBN
  // typed here still matches, and a query with no digits/X never
  // spuriously matches every row via an empty-string `contains`.
  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(query);
  const normalizedIsbnQuery = query && looksLikeIsbnQuery ? normalizeIsbn(query) : "";

  // Built as an explicit filters array combined via `{ AND: filters }`
  // (matching searchCatalog's pattern) rather than spreading multiple
  // conditions into one flat where object -- buildStatusWhere can itself
  // return a top-level `OR` key, which would silently collide with the
  // query-text OR clause below under a plain object spread.
  const filters: Prisma.BookWhereInput[] = [];
  if (query) {
    filters.push({
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { author: { contains: query, mode: "insensitive" } },
        ...(normalizedIsbnQuery
          ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
          : []),
      ],
    });
  }
  if (format) {
    filters.push({ copies: { some: { format } } });
  }
  const statusWhere = buildStatusWhere(status, statusMode);
  if (statusWhere) filters.push(statusWhere);

  const books = await prisma.book.findMany({
    where: { AND: filters },
    include: { copies: true },
    orderBy: { title: "asc" },
  });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Physical Books</h1>
        <Link href="/books/scan" className="rounded bg-black px-3 py-2 text-sm text-white">
          + Add a book
        </Link>
      </div>

      <div className="mb-4 text-sm">
        <Link href="/books/duplicates" className="underline">
          Check for duplicate books
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4 space-y-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
          className="w-full rounded border p-2"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-1">
              <input
                type="checkbox"
                name="status"
                value={opt.value}
                defaultChecked={status?.includes(opt.value) ?? false}
              />
              {opt.label}
            </label>
          ))}
          <span className="flex items-center gap-1 text-gray-500">
            Match:
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="statusMode"
                value="or"
                defaultChecked={statusMode === "or"}
              />
              Any
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="statusMode"
                value="and"
                defaultChecked={statusMode === "and"}
              />
              All
            </label>
          </span>
          <select
            name="format"
            defaultValue={format ?? ""}
            className="rounded border p-1"
            aria-label="Filter by physical format"
          >
            <option value="">Any format</option>
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-black px-3 py-1 text-white">
            Search
          </button>
        </div>
      </form>

      {books.length === 0 ? (
        <p className="text-gray-600">No books found.</p>
      ) : (
        <ul className="space-y-3">
          {books.map((book) => (
            <li key={book.id} className="rounded border p-3">
              <Link href={`/books/${book.id}`} className="font-medium hover:underline">
                {book.title}
              </Link>
              {book.author && <p className="text-sm text-gray-600">{book.author}</p>}
              <p className="text-sm text-gray-500">
                {book.copies.length} {book.copies.length === 1 ? "copy" : "copies"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass (no `.tsx` tests exist for this file, so this just confirms nothing else broke), no type errors.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`, then in a browser visit `http://localhost:3000/books`, `http://localhost:3000/books?status=reading`, and `http://localhost:3000/books?status=reading&status=unrated&statusMode=and`. Confirm the status checkboxes/match-mode radio render, stay checked after submit (reflecting the URL), and the result list narrows correctly for the AND case (should show only books that are both "reading" AND "unrated" — likely zero or very few, since a book's `readStatus` and `rating` are independent columns, this combination is meaningful, unlike two different `readStatus` values ANDed together).

- [ ] **Step 4: Commit**

```bash
git add src/app/books/page.tsx
git commit -m "feat: add read-status/rating filter to /books, matching the home page"
```

---

### Task 3: Sort, filter, and group TBR items

**Files:**
- Modify: `src/lib/tbrGap.ts`
- Test: `src/lib/tbrGap.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/tbrGap.test.ts` with:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getTbrGap, groupByInitial, type TbrGapItem } from "@/lib/tbrGap";

afterEach(async () => {
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test TBR" } } },
  });
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test TBR" } } } });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test TBR" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
});

describe("getTbrGap", () => {
  it("excludes a TBR item that matches an owned physical book", async () => {
    await prisma.book.create({
      data: { title: "Test TBR Owned Book", copies: { create: { format: "PAPERBACK" } } },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Owned Book", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Owned Book")).toBe(false);
  });

  it("excludes a TBR item that matches an ebook/audiobook-only Book", async () => {
    await prisma.book.create({
      data: {
        title: "Test TBR Abs Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-tbr-abs-1" } },
      },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Abs Book", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Abs Book")).toBe(false);
  });

  it("includes a TBR item not owned in any form", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Not Owned", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Not Owned")).toBe(true);
  });

  it("sorts by author when present, falling back to title otherwise", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Zzz Title", author: "Aaa Author" },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Bbb Title", author: null },
    });

    const gap = await getTbrGap();
    const titles = gap
      .filter((item) => item.title.startsWith("Test TBR"))
      .map((item) => item.title);

    // "Aaa Author" sorts before "Bbb Title" (its own sort key, since it has no author)
    expect(titles.indexOf("Test TBR Zzz Title")).toBeLessThan(
      titles.indexOf("Test TBR Bbb Title"),
    );
  });

  it("filters by a case-insensitive title match when a query is given", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mistborn", author: "Brandon Sanderson" },
    });

    const gap = await getTbrGap("mistborn");

    expect(gap.some((item) => item.title === "Test TBR Mistborn")).toBe(true);
  });

  it("filters by a case-insensitive author match when a query is given", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Elantris", author: "Brandon Sanderson" },
    });

    const gap = await getTbrGap("sanderson");

    expect(gap.some((item) => item.title === "Test TBR Elantris")).toBe(true);
  });

  it("excludes items that don't match the query", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Elantris", author: "Brandon Sanderson" },
    });

    const gap = await getTbrGap("Test TBR Nonexistent Zzzzz");

    expect(gap.some((item) => item.title === "Test TBR Elantris")).toBe(false);
  });

  it("returns everything when the query is empty or undefined", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Elantris", author: "Brandon Sanderson" },
    });

    const gapUndefined = await getTbrGap();
    const gapEmpty = await getTbrGap("   ");

    expect(gapUndefined.some((item) => item.title === "Test TBR Elantris")).toBe(true);
    expect(gapEmpty.some((item) => item.title === "Test TBR Elantris")).toBe(true);
  });
});

describe("groupByInitial", () => {
  function item(title: string, author: string | null): TbrGapItem {
    return { id: title, title, author };
  }

  it("groups items by the uppercased first character of their sort key", () => {
    const groups = groupByInitial([
      item("Elantris", "Brandon Sanderson"),
      item("A Wizard of Earthsea", "Ursula K. Le Guin"),
    ]);

    expect(groups).toEqual([
      { letter: "B", items: [item("Elantris", "Brandon Sanderson")] },
      { letter: "U", items: [item("A Wizard of Earthsea", "Ursula K. Le Guin")] },
    ]);
  });

  it("falls back to title when author is null", () => {
    const groups = groupByInitial([item("Zzz Title", null)]);

    expect(groups).toEqual([{ letter: "Z", items: [item("Zzz Title", null)] }]);
  });

  it("buckets a non-letter first character under '#'", () => {
    const groups = groupByInitial([item("1984", null)]);

    expect(groups).toEqual([{ letter: "#", items: [item("1984", null)] }]);
  });

  it("does not include a letter with zero matching items", () => {
    const groups = groupByInitial([item("Elantris", "Brandon Sanderson")]);

    expect(groups.some((g) => g.letter === "Z")).toBe(false);
    expect(groups).toHaveLength(1);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupByInitial([])).toEqual([]);
  });

  it("preserves each group's relative item order", () => {
    const groups = groupByInitial([
      item("Aaa First", "Sanderson, A"),
      item("Aaa Second", "Sanderson, B"),
    ]);

    expect(groups).toEqual([
      {
        letter: "S",
        items: [item("Aaa First", "Sanderson, A"), item("Aaa Second", "Sanderson, B")],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tbrGap.test.ts`
Expected: FAIL — `groupByInitial` isn't exported, `getTbrGap` doesn't accept a query argument, and results aren't sorted yet.

- [ ] **Step 3: Implement sorting, filtering, and grouping**

Replace `src/lib/tbrGap.ts` with:

```ts
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
}

/** Tag used to invalidate the cached TBR gap computation after a sync completes. */
export const TBR_GAP_CACHE_TAG = "tbr-gap";

// Author (trimmed) if present, else title (trimmed) -- used both to sort the
// full list and to decide which letter bucket an item falls into in
// groupByInitial, so the two always agree on what "browsing alphabetically"
// means for a given item.
function sortKey(item: Pick<TbrGapItem, "title" | "author">): string {
  return item.author?.trim() || item.title.trim();
}

async function computeTbrGap(): Promise<TbrGapItem[]> {
  const [tbrItems, books] = await Promise.all([
    prisma.goodreadsTbrItem.findMany({ select: { id: true, title: true, author: true } }),
    prisma.book.findMany({ select: { title: true } }),
  ]);

  const ownedTitles = books.map((b) => b.title);

  return tbrItems
    .filter((tbr) => !ownedTitles.some((owned) => isTitleMatch(tbr.title, owned)))
    .map((tbr) => ({ id: tbr.id, title: tbr.title, author: tbr.author }))
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { sensitivity: "base" }));
}

// Cache the expensive fuzzy-matching computation rather than re-running it on
// every page load. Revalidated on-demand via revalidateTag(TBR_GAP_CACHE_TAG)
// when a manual sync completes via the /api/sync/* route handlers. The
// scheduled cron syncs in src/instrumentation.ts do NOT call revalidateTag —
// revalidateTag requires an active Next.js request/action context and throws
// when called from a node-cron callback, which runs outside any such context
// — so this 30-minute revalidate window is not just a rare safety net, it's
// the only invalidation path for cron-triggered syncs. Up to ~30 minutes of
// staleness after an automatic sync is expected and accepted, matching the
// cron interval itself; only the manual "Refresh now" path gets immediate
// freshness.
const getCachedTbrGap = unstable_cache(computeTbrGap, ["tbr-gap"], {
  tags: [TBR_GAP_CACHE_TAG],
  revalidate: 1800,
});

// `query` is applied in-memory, after the cache lookup, against the full
// (already sorted) gap list -- filtering ~800 items in-process is cheap, and
// keeping the cache keyed only on the unfiltered gap avoids a per-query cache
// entry for what would otherwise be an unbounded set of possible query
// strings.
export async function getTbrGap(query?: string): Promise<TbrGapItem[]> {
  // unstable_cache requires an active Next.js request/render context (it
  // looks up an incrementalCache via async storage), which a Vitest unit
  // test running in a plain Node process never has. Rather than calling
  // the cached function and pattern-matching its error message to detect
  // this (brittle across Next.js versions), check NODE_ENV up front —
  // Vitest sets it to "test" automatically — and skip the cache entirely
  // in that case. In any other environment, call the cached function
  // directly with no fallback: a real caching failure should throw loudly
  // (a failed page load) rather than silently degrade into a slow,
  // uncached computation.
  const gap = process.env.NODE_ENV === "test" ? await computeTbrGap() : await getCachedTbrGap();

  const trimmed = query?.trim().toLowerCase();
  if (!trimmed) return gap;
  return gap.filter(
    (item) =>
      item.title.toLowerCase().includes(trimmed) ||
      (item.author?.toLowerCase().includes(trimmed) ?? false),
  );
}

export interface TbrGapGroup {
  letter: string;
  items: TbrGapItem[];
}

// Assumes `items` is already sorted by the same sortKey used here (true for
// whatever getTbrGap returns) -- this only groups, it doesn't re-sort, so
// each group's items stay in the order they arrived in.
export function groupByInitial(items: TbrGapItem[]): TbrGapGroup[] {
  const groups = new Map<string, TbrGapItem[]>();
  for (const item of items) {
    const firstChar = sortKey(item).charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(firstChar) ? firstChar : "#";
    const group = groups.get(letter);
    if (group) {
      group.push(item);
    } else {
      groups.set(letter, [item]);
    }
  }

  const letters = [...groups.keys()].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  return letters.map((letter) => ({ letter, items: groups.get(letter)! }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tbrGap.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors. Check whether anything else in the codebase calls `getTbrGap()` with the old no-argument signature (it still works — `query` is optional) or imports `TbrGapItem`/`TBR_GAP_CACHE_TAG` (unchanged exports, still fine):

Run: `grep -rn "getTbrGap\|from \"@/lib/tbrGap\"" src --include=*.ts --include=*.tsx`

Expected: only `src/app/tbr/page.tsx` (not yet updated — Task 4) and `src/lib/tbrGap.test.ts` reference it, plus wherever `TBR_GAP_CACHE_TAG` is used for `revalidateTag` (leave those call sites untouched, they don't need `query`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tbrGap.ts src/lib/tbrGap.test.ts
git commit -m "feat: sort TBR gap items and add query filtering + alphabetical grouping"
```

---

### Task 4: Add search box + jump nav to `/tbr`

**Files:**
- Modify: `src/app/tbr/page.tsx`

- [ ] **Step 1: Update `src/app/tbr/page.tsx`**

Replace the full file with:

```tsx
import Link from "next/link";
import { getTbrGap, groupByInitial } from "@/lib/tbrGap";

export const dynamic = "force-dynamic";

export default async function TbrGapPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const gap = await getTbrGap(query);
  const groups = groupByInitial(gap);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">TBR — Not Yet Owned</h1>
        <Link href="/" className="text-sm underline">
          Back to search
        </Link>
      </div>

      <form action="/tbr" method="get" className="mb-4">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title or author"
          className="w-full rounded border p-2"
        />
      </form>

      {groups.length > 0 && (
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Jump to letter">
          {groups.map((group) => (
            <a key={group.letter} href={`#letter-${group.letter}`} className="underline">
              {group.letter}
            </a>
          ))}
        </nav>
      )}

      {gap.length === 0 ? (
        <p className="text-gray-600">
          {query
            ? "No matches found."
            : "Everything on your to-read shelf is already owned in some form."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.letter} className="mb-4">
            <h2
              id={`letter-${group.letter}`}
              className="mb-2 text-lg font-semibold text-gray-700"
            >
              {group.letter}
            </h2>
            <ul className="space-y-2">
              {group.items.map((item) => (
                <li key={item.id} className="rounded border p-3">
                  <p className="font-medium">{item.title}</p>
                  {item.author && <p className="text-sm text-gray-600">{item.author}</p>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`, then in a browser visit `http://localhost:3000/tbr`. Confirm: the jump nav renders with a plausible set of letters, clicking a letter jumps to that section, the search box narrows the list (and the jump nav) when given a real title/author substring from your actual TBR data, and an empty/no-match search shows the right message.

- [ ] **Step 4: Commit**

```bash
git add src/app/tbr/page.tsx
git commit -m "feat: add search box and alphabetical jump list to /tbr"
```

---

**Self-review notes (spec coverage check):**
- Spec's "/books filters" section → Tasks 1-2. ✅
- Spec's "/tbr search box + jump list" section → Tasks 3-4. ✅
- Spec's "shared architecture" section (`buildStatusWhere` extraction, `getTbrGap(query)` in-memory filtering post-cache, `groupByInitial` pure helper) → Task 1 and Task 3. ✅
- Spec's testing section → Task 1 Step 1 (`buildStatusWhere`), Task 3 Step 1 (`tbrGap.ts` sorting/filtering/grouping). ✅
- Spec's non-goals (no client JS, no pagination, no home-page changes, no /tbr format/status filter) → nothing in this plan violates them. ✅
