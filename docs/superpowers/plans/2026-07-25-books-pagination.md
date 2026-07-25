# Books Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/books` from rendering the entire catalog (measured 2.3–2.9s, 4.3MB HTML at ~1800-book scale) on every load by adding a "Load more" style limit to the query.

**Architecture:** Add an optional `limit` to `searchCatalog`'s options (Prisma `take`), unused by every existing caller except `/books/page.tsx`. The page reads a `limit` search param (default 50), fetches `limit + 1` rows to cheaply detect whether more exist, and renders a "Load more" link that reloads the page with a bigger `limit`, preserving every other active filter/search param.

**Tech Stack:** TypeScript, Prisma, Next.js 16 App Router (server component), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-performance-fixes-design.md` (Books pagination section — the TBR ownership-tracking section is a separate plan, `docs/superpowers/plans/2026-07-25-tbr-ownership-tracking.md`).

---

### Task 1: `limit` option on `searchCatalog`

**Files:**
- Modify: `src/lib/search.ts`
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/search.test.ts`, near the other `browseAll` tests:

```ts
  it("returns at most `limit` results when browsing all", async () => {
    await prisma.book.create({ data: { title: "Test Search Limit One" } });
    await prisma.book.create({ data: { title: "Test Search Limit Two" } });
    await prisma.book.create({ data: { title: "Test Search Limit Three" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "title", limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("returns every result when limit is omitted", async () => {
    await prisma.book.create({ data: { title: "Test Search No Limit One" } });
    await prisma.book.create({ data: { title: "Test Search No Limit Two" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "title" });

    expect(results.filter((r) => r.title.startsWith("Test Search No Limit")).length).toBe(2);
  });
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `npm test -- search.test.ts`
Expected: FAIL on the `limit: 2` test (TypeScript error: `limit` doesn't exist on `SearchOptions`, or if it compiles anyway, `results` has all 3+ rows instead of 2).

- [ ] **Step 3: Implement**

In `src/lib/search.ts`:

1. Add to `SearchOptions` (near the other fields, line 27-35):

```ts
export interface SearchOptions {
  query?: string;
  types?: OwnershipType[];
  format?: Format;
  status?: ReadStatusFilterValue[];
  statusMode?: StatusFilterMode;
  browseAll?: boolean;
  sortBy?: "id" | "title";
  limit?: number;
}
```

2. In `searchCatalog`, pass it through to the Prisma call (around line 170-182):

```ts
  const books = await prisma.book.findMany({
    where: { AND: filters },
    include: {
      copies: { where: format ? { format } : undefined },
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy: sortBy === "title" ? [{ title: "asc" }, { id: "asc" }] : { id: "asc" },
    ...(options.limit !== undefined ? { take: options.limit } : {}),
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- search.test.ts`
Expected: PASS, including every pre-existing test in this file (confirms the home-page caller's unlimited behavior is unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add optional limit to searchCatalog"
```

---

### Task 2: "Load more" pagination on `/books`

**Files:**
- Modify: `src/app/books/page.tsx`

No new automated test for this task — this repo has no existing precedent for unit-testing an App Router page component directly (coverage instead comes from `searchCatalog`'s own tests in Task 1, plus a manual/Playwright check in Task 3). Follow this project's established "seed real rows, verify in a real browser" convention for the final check.

- [ ] **Step 1: Implement**

Replace `src/app/books/page.tsx` with:

```tsx
import Link from "next/link";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
} from "@/lib/search";
import { CatalogFilters } from "@/components/CatalogFilters";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

const DEFAULT_PAGE_SIZE = 50;

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
    limit?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
    limit: limitParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);

  const parsedLimit = limitParam ? parseInt(limitParam, 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_PAGE_SIZE;

  const fetched = await searchCatalog({
    query,
    types,
    format,
    status,
    statusMode,
    browseAll: true,
    sortBy: "title",
    limit: limit + 1,
  });
  const hasMore = fetched.length > limit;
  const results = hasMore ? fetched.slice(0, limit) : fetched;

  const loadMoreParams = new URLSearchParams();
  if (query) loadMoreParams.set("q", query);
  if (types) loadMoreParams.set("types", types.join(","));
  if (format) loadMoreParams.set("format", format);
  if (status) loadMoreParams.set("status", status.join(","));
  if (statusMode !== "or") loadMoreParams.set("statusMode", statusMode);
  loadMoreParams.set("limit", String(limit + DEFAULT_PAGE_SIZE));

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">All Books</h1>
        <Link
          href="/books/scan"
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.primary}`}
        >
          + Add a book
        </Link>
      </div>

      <div className="mb-4 text-sm">
        <Link href="/books/duplicates" className="text-link underline">
          Check for duplicate books
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4 space-y-2">
        <SearchAutocomplete
          scope="books"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
        />
        <CatalogFilters types={types} status={status} statusMode={statusMode} format={format} />
      </form>

      {results.length === 0 ? (
        <p className="text-foreground/70">No books found.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {results.map((result) => (
              <CatalogResultCard key={result.bookId ?? result.title} result={result} />
            ))}
          </ul>
          {hasMore && (
            <div className="mt-4 text-center">
              <Link
                href={`/books?${loadMoreParams.toString()}`}
                className={`inline-block rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
              >
                Load more
              </Link>
            </div>
          )}
        </>
      )}
    </main>
  );
}
```

Note: `results.length === 0` still correctly reports "no books found" — it's computed from the sliced `results`, which is `[]` exactly when `fetched` (the `limit + 1` query) came back empty.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/books/page.tsx
git commit -m "feat: paginate /books with a Load more link"
```

---

### Task 3: Manual verification against realistic scale

**Files:** none (verification only)

- [ ] **Step 1: Seed a realistic-scale fixture in the isolated test database**

Follow this project's established convention (see the `perfTitle()`-style generator used in `src/lib/duplicates.test.ts`'s performance-scale tests) to seed ~1000+ `Book` rows into `bookcatalog_test` — NOT the real dev database (`bookcatalog`). Double-check `DATABASE_URL` before running anything, per this project's prior incident where a dev server accidentally pointed at the shared dev DB during verification.

- [ ] **Step 2: Time the page load**

With the dev server pointed at the seeded test database, request `/books` (e.g. via `curl -w "%{time_total}\n" -o /dev/null -s http://localhost:3000/books`) and confirm the response time and payload size are now small (comparable to a 50-row page, not the full catalog) and that repeating with `?limit=100` etc. still works.

- [ ] **Step 3: Confirm "Load more" works end to end in a real browser**

Load `/books`, confirm exactly `DEFAULT_PAGE_SIZE` (50) results render plus a "Load more" link, click it, confirm the next 50 append (as a fresh page load) and the link's `href` still carries any active filter/search params if you set one before clicking.

- [ ] **Step 4: Clean up the seeded fixture**

Delete every seeded row from `bookcatalog_test` and confirm via a count query that none remain, matching this project's established cleanup discipline for performance-scale test fixtures.
