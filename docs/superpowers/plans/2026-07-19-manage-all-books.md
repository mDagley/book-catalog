# Manage All Books Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/books` from a physical-only page into "All Books" — a dedicated browse/manage page for the whole catalog (physical + ebook + audiobook), reusing the home page's existing `searchCatalog` infrastructure instead of a parallel physical-only query.

**Architecture:** Extend `searchCatalog` (`src/lib/search.ts`) with two new, backward-compatible options (`browseAll`, `sortBy`) so it can serve both home's search-first behavior (unchanged) and `/books`' browse-everything-by-default behavior. Extract two shared components (`CatalogResultCard`, `CatalogFilters`) out of the home page's existing JSX so `/books` doesn't duplicate them, then rewrite `/books/page.tsx` on top of `searchCatalog` + the shared components.

**Tech Stack:** TypeScript, Next.js App Router (Server Components), Prisma, Vitest with a real isolated Postgres test DB.

---

## Design spec

Full rationale: `docs/superpowers/specs/2026-07-19-manage-all-books-design.md`. Read it before starting.

## Task 1: Extend searchCatalog with browseAll and sortBy options

**Files:**
- Modify: `src/lib/search.ts`
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe("searchCatalog", ...)` block in `src/lib/search.test.ts`, right after the existing `"returns an empty array when there is no query and no filters"` test (around line 82):

```typescript
  it("returns every book when browseAll is true and no other filters are set", async () => {
    const countBefore = await prisma.book.count();
    await prisma.book.create({ data: { title: "Test Search Browse All One" } });
    await prisma.book.create({ data: { title: "Test Search Browse All Two" } });

    const results = await searchCatalog({ browseAll: true });

    expect(results).toHaveLength(countBefore + 2);
    const titles = results.map((r) => r.title);
    expect(titles).toContain("Test Search Browse All One");
    expect(titles).toContain("Test Search Browse All Two");
  });

  it("still returns an empty array with no filters when browseAll is false or omitted", async () => {
    await prisma.book.create({ data: { title: "Test Search Browse All Omitted" } });

    expect(await searchCatalog({})).toEqual([]);
    expect(await searchCatalog({ browseAll: false })).toEqual([]);
  });

  it("sorts by title ascending when sortBy is 'title'", async () => {
    await prisma.book.create({ data: { title: "Test Search Sort Zebra" } });
    await prisma.book.create({ data: { title: "Test Search Sort Apple" } });
    await prisma.book.create({ data: { title: "Test Search Sort Mango" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "title" });

    const ourTitles = results.map((r) => r.title).filter((t) => t.startsWith("Test Search Sort"));
    expect(ourTitles).toEqual([
      "Test Search Sort Apple",
      "Test Search Sort Mango",
      "Test Search Sort Zebra",
    ]);
  });

  it("defaults to id-ascending order when sortBy is omitted (preserves existing behavior)", async () => {
    const first = await prisma.book.create({ data: { title: "Test Search Sort Order Beta" } });
    const second = await prisma.book.create({ data: { title: "Test Search Sort Order Alpha" } });

    const results = await searchCatalog({ browseAll: true });

    const ourResults = results.filter((r) => r.title.startsWith("Test Search Sort Order"));
    expect(ourResults.map((r) => r.bookId)).toEqual([first.id, second.id]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/search.test.ts -t "browseAll|sortBy is 'title'|id-ascending order"`

Expected: FAIL. `browseAll` and `sortBy` aren't recognized options yet (TypeScript will actually reject the extra properties on `SearchOptions` — if using `npx tsc --noEmit` shows type errors on the new test code, that's expected too at this point; the vitest run itself should fail at runtime with the empty-array-by-default and id-order behavior not matching the new tests' expectations).

- [ ] **Step 3: Implement browseAll and sortBy**

In `src/lib/search.ts`, update the `SearchOptions` interface:

```typescript
export interface SearchOptions {
  query?: string;
  types?: OwnershipType[];
  format?: Format;
  status?: ReadStatusFilterValue[];
  statusMode?: StatusFilterMode;
  browseAll?: boolean;
  sortBy?: "id" | "title";
}
```

Then update `searchCatalog`'s body (only the two lines shown need to change — the early-return guard and the `orderBy`):

```typescript
export async function searchCatalog(options: SearchOptions): Promise<SearchResult[]> {
  const trimmed = options.query?.trim() ?? "";
  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;
  const statusValues = options.status && options.status.length > 0 ? options.status : undefined;
  const browseAll = options.browseAll ?? false;
  const sortBy = options.sortBy ?? "id";

  if (!browseAll && !trimmed && !types && !format && !statusValues) return [];

  // ... (everything in between is unchanged) ...

  const books = await prisma.book.findMany({
    where: { AND: filters },
    include: {
      copies: { where: format ? { format } : undefined },
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy: sortBy === "title" ? { title: "asc" } : { id: "asc" },
  });

  // ... (return mapping unchanged) ...
}
```

Note: with `browseAll: true` and no other filters, `filters` stays an empty array, so the query becomes `where: { AND: [] }`. This is already a verified-safe pattern in this codebase — the pre-existing `/books` page used exactly this shape (`where: { AND: filters }` with a potentially-empty `filters` array) for its own default unfiltered view, and PR #20's whole-branch review independently confirmed `{ AND: [] }` behaves identically to `{}` (matches everything) by querying the real dev DB both ways.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/search.test.ts`

Expected: ALL tests in this file pass (the 4 new ones, plus all existing ones — especially `"returns an empty array when there is no query and no filters"`, which must keep passing unmodified since `browseAll` defaults to `false`).

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit` and `npx eslint src/lib/search.ts src/lib/search.test.ts`

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add browseAll and sortBy options to searchCatalog

Two new, backward-compatible SearchOptions: browseAll (skips the
empty-by-default early return so a call with no filters returns every
book) and sortBy ('id' | 'title', defaulting to 'id' to preserve
existing behavior). Home's own calls are unaffected (never passes
either). Enables the upcoming /books 'All Books' page to reuse this
function instead of a parallel physical-only query."
```

## Task 2: Extract shared CatalogResultCard and CatalogFilters components

**Files:**
- Create: `src/components/CatalogResultCard.tsx`
- Create: `src/components/CatalogFilters.tsx`
- Modify: `src/app/page.tsx` (use the two new components; no rendered-output change)

This is a pure refactor — the home page's rendered HTML must not change. There's no dedicated test for this (this app has no page-rendering tests anywhere, per established convention); verification is via TypeScript/lint plus a manual visual check in Task 4's QA pass, and by diffing home's rendered output isn't practical without a browser, so this task's own verification is: `tsc`/`eslint` clean, `npm test` still green (nothing here should affect any existing test), and the code is a byte-for-byte-equivalent extraction (same JSX, same conditions, same classes) so there is no behavior to regress.

- [ ] **Step 1: Create CatalogResultCard**

Read `src/app/page.tsx`'s current results-rendering block first (the `<li key={result.bookId ?? result.title} className="rounded border p-3">...</li>` block, currently around lines 148-188) to copy it exactly.

Create `src/components/CatalogResultCard.tsx`:

```typescript
import Link from "next/link";
import type { SearchResult } from "@/lib/search";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_LABELS, ratingStars } from "@/components/ReadingProgressFields";
import { CoverThumbnail } from "@/components/CoverThumbnail";

// One catalog entry as rendered in a search/browse result list -- shared
// between the home page's unified search and /books' "All Books" browse
// view, both of which render searchCatalog() results identically.
export function CatalogResultCard({ result }: { result: SearchResult }) {
  return (
    <li className="rounded border p-3">
      <CoverThumbnail coverImagePath={result.coverImagePath} />
      <p className="font-medium">{result.title}</p>
      {result.author && <p className="text-sm text-gray-600">{result.author}</p>}
      <div className="mt-1 flex flex-wrap gap-2 text-sm">
        {result.physicalCopies.map((copy) => (
          <span key={copy.id} className="rounded bg-gray-100 px-2 py-0.5">
            Physical ({FORMAT_LABELS[copy.format]}
            {copy.publisher ? `, ${copy.publisher}` : ""}
            {copy.publishYear ? ` ${copy.publishYear}` : ""})
          </span>
        ))}
        {result.hasEbook && <span className="rounded bg-gray-100 px-2 py-0.5">Ebook ✓</span>}
        {result.hasAudiobook && (
          <span className="rounded bg-gray-100 px-2 py-0.5">Audiobook ✓</span>
        )}
        {result.readStatus && (
          <span className="rounded bg-gray-100 px-2 py-0.5">
            {READ_STATUS_LABELS[result.readStatus]}
          </span>
        )}
        {result.rating !== null && (
          <span
            className="rounded bg-gray-100 px-2 py-0.5"
            aria-label={`Rated ${result.rating} out of 5`}
          >
            {ratingStars(result.rating)}
          </span>
        )}
      </div>
      {result.bookId && (
        <Link href={`/books/${result.bookId}`} className="mt-1 inline-block text-sm underline">
          View details
        </Link>
      )}
    </li>
  );
}
```

- [ ] **Step 2: Update home to use CatalogResultCard**

In `src/app/page.tsx`, replace the `<ul>...</ul>` results block with:

```tsx
      {results.length > 0 && (
        <ul className="space-y-3">
          {results.map((result) => (
            <CatalogResultCard key={result.bookId ?? result.title} result={result} />
          ))}
        </ul>
      )}
```

Add the import: `import { CatalogResultCard } from "@/components/CatalogResultCard";`. Remove the now-unused `FORMAT_LABELS`, `READ_STATUS_LABELS`, `ratingStars`, `CoverThumbnail` imports from `src/app/page.tsx` if nothing else in that file still uses them (check first — `CoverThumbnail` and `FORMAT_LABELS` are only used in the block you just removed; `READ_STATUS_LABELS`/`ratingStars` likewise).

- [ ] **Step 3: Create CatalogFilters**

Read `src/app/page.tsx`'s current filter-row block (the `<div className="flex flex-wrap items-center gap-3 text-sm">...</div>` inside the `<form>`, currently around lines 69-129) to copy it exactly, ADDING the ownership-type checkboxes that don't exist on `/books` yet but do on home.

Create `src/components/CatalogFilters.tsx`:

```typescript
import { FORMAT_OPTIONS } from "@/components/CopyFormFields";
import { STATUS_FILTER_OPTIONS } from "@/components/ReadingProgressFields";
import type { OwnershipType, ReadStatusFilterValue, StatusFilterMode } from "@/lib/search";
import type { Format } from "@prisma/client";

export const OWNERSHIP_TYPE_OPTIONS: { value: OwnershipType; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "ebook", label: "Ebook" },
  { value: "audiobook", label: "Audiobook" },
];

interface CatalogFiltersProps {
  types?: OwnershipType[];
  status?: ReadStatusFilterValue[];
  statusMode: StatusFilterMode;
  format?: Format;
}

// The ownership-type/status/format filter row shared between the home
// page's unified search and /books' "All Books" browse view. Rendered
// inside each page's own <form>, alongside that page's own
// SearchAutocomplete (which has a different `scope` per page, so it stays
// outside this shared component).
export function CatalogFilters({ types, status, statusMode, format }: CatalogFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {OWNERSHIP_TYPE_OPTIONS.map((opt) => (
        <label key={opt.value} className="flex items-center gap-1">
          <input
            type="checkbox"
            name="types"
            value={opt.value}
            defaultChecked={types?.includes(opt.value) ?? false}
          />
          {opt.label}
        </label>
      ))}
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
          <input type="radio" name="statusMode" value="or" defaultChecked={statusMode === "or"} />
          Any
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="statusMode" value="and" defaultChecked={statusMode === "and"} />
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
  );
}
```

- [ ] **Step 4: Update home to use CatalogFilters**

In `src/app/page.tsx`, replace the filter-row `<div>` (the one just extracted) with:

```tsx
        <CatalogFilters types={types} status={status} statusMode={statusMode} format={format} />
```

Add the import: `import { CatalogFilters } from "@/components/CatalogFilters";`. Remove the now-inline `OWNERSHIP_TYPE_OPTIONS` constant from `src/app/page.tsx` (it moved into `CatalogFilters.tsx`) and its now-unused imports: `FORMAT_OPTIONS`/`STATUS_FILTER_OPTIONS`, and the `type OwnershipType` named import from the existing `@/lib/search` import line (it was only ever used to type `OWNERSHIP_TYPE_OPTIONS`, which no longer lives in this file) — `searchCatalog`/`parseFormatParam`/`parseTypesParam`/`parseStatusParam`/`parseStatusModeParam` are all still needed and stay.

- [ ] **Step 5: Typecheck, lint, and run the full test suite**

Run: `npx tsc --noEmit`, `npx eslint src/app/page.tsx src/components/CatalogResultCard.tsx src/components/CatalogFilters.tsx`, `npm test`

Expected: all clean, all tests passing (this refactor shouldn't change any test's outcome — no tests directly render `page.tsx`, but confirm nothing else broke).

- [ ] **Step 6: Manually verify the home page still renders identically**

Start the dev server (`npm run dev` if not already running) and visually confirm `/` looks and behaves exactly as before: type checkboxes, status checkboxes, Any/All radio, format select, search button all present and functional, results render with the same badges as before. This is the actual regression check for a refactor with no automated test coverage.

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx src/components/CatalogResultCard.tsx src/components/CatalogFilters.tsx
git commit -m "refactor: extract CatalogResultCard and CatalogFilters from the home page

Pure extraction, no behavior change -- home's rendered output and
filter row are byte-for-byte equivalent to before. Prepares for /books'
'All Books' rewrite (Task 3) to reuse both instead of duplicating them,
closing the exact kind of drift that already happened once between
/books' old physical-only query and searchCatalog."
```

## Task 3: Rewrite /books as the All Books page

**Files:**
- Modify: `src/app/books/page.tsx`
- Modify: `src/app/page.tsx` (update the "Manage physical books" link text)

- [ ] **Step 1: Rewrite src/app/books/page.tsx**

Replace the entire file with:

```typescript
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

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);

  const results = await searchCatalog({
    query,
    types,
    format,
    status,
    statusMode,
    browseAll: true,
    sortBy: "title",
  });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">All Books</h1>
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
        <SearchAutocomplete
          scope="books"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
        />
        <CatalogFilters types={types} status={status} statusMode={statusMode} format={format} />
      </form>

      {results.length === 0 ? (
        <p className="text-gray-600">No books found.</p>
      ) : (
        <ul className="space-y-3">
          {results.map((result) => (
            <CatalogResultCard key={result.bookId ?? result.title} result={result} />
          ))}
        </ul>
      )}
    </main>
  );
}
```

(`result.bookId ?? result.title` matches the exact key pattern preserved on home in Task 2 — `SearchResult.bookId` is always a real string in practice, but keeping the same defensive fallback here matches the established pattern rather than introducing an unexplained difference.)

Note: `results.length === 0` can now only happen with an active filter/query that matches nothing (or a genuinely empty catalog), since `browseAll: true` means no filters = show everything.

- [ ] **Step 2: Update home's "Manage physical books" link text**

In `src/app/page.tsx`, find:

```tsx
        <Link href="/books" className="underline">
          Manage physical books
        </Link>
```

Change the link text to:

```tsx
        <Link href="/books" className="underline">
          Manage all books
        </Link>
```

- [ ] **Step 3: Typecheck, lint, and run the full test suite**

Run: `npx tsc --noEmit`, `npx eslint src/app/books/page.tsx src/app/page.tsx`, `npm test`

Expected: all clean, all tests passing.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/page.tsx src/app/page.tsx
git commit -m "feat: rework /books into 'All Books' -- physical + ebook + audiobook

Replaces the page's own physical-only Prisma query with searchCatalog
(browseAll: true, sortBy: 'title'), reusing the CatalogFilters/
CatalogResultCard components extracted from home in the previous
commit. Shows everything by default (no type filter required), with
the same ownership-type/format/status filters home already has.

Also closes backlog item #7 by construction: a Book with only digital
ownership no longer looks out of place, since the page's scope is
legitimately 'all books' now, not 'physical books.'

+ Add a book and the duplicates link stay as-is -- physical scan-add
remains the only manual-add path in the app regardless of what else
the page now shows."
```

## Task 4: Integration verification and manual QA

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite one more time**

Run: `npm test`

Expected: all tests passing (this confirms Tasks 1-3 together haven't introduced any interaction issues).

- [ ] **Step 2: Typecheck and lint the whole project**

Run: `npx tsc --noEmit` and `npx eslint .`

Expected: both clean (aside from any pre-existing, unrelated findings — confirm any such finding predates this branch via `git stash` + re-run, or `git diff master` to check it's not in a file this plan touched).

- [ ] **Step 3: Manual browser QA**

Using the app's established session-cookie-minting approach (see project conventions) or a real login, verify in a real browser:
- `/books` loads and shows every book by default (physical, ebook, and audiobook), sorted alphabetically by title.
- Checking "Ebook" only narrows results to ebook-owned books; checking "Physical" + selecting a format narrows to that format specifically.
- Status/rating filters and the Any/All match mode work identically to how they already work on home.
- Search box (title/author/ISBN) still works and is autocomplete-enabled.
- `+ Add a book` still goes to the barcode scan flow; `Check for duplicate books` still goes to `/books/duplicates`.
- Each result card shows the same ownership badges as home's search results (physical format, ebook ✓, audiobook ✓, read status, rating stars where applicable) and links to `/books/[id]`.
- Home page (`/`) still behaves exactly as before: empty by default, only shows results once you search or filter, and its own "Manage all books" link goes to `/books`.

- [ ] **Step 4: Report findings**

If any of the manual QA checks fail, fix them before considering this plan complete. If everything passes, this plan is done.

## Non-goals (do not implement)

- No changes to `/books/[id]` or any copy-management/edit flows.
- No bulk actions.
- No changes to how ebook/audiobook copies get added.
- No changes to the autocomplete route's ISBN-matching gap (backlog item #14's remaining scope, outside this plan).
