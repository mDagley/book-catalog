# Books List Density & Findability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/books` usable at real library scale by shipping a 2.7×-denser "compact" row layout with a per-view density toggle, four sort options, a result count, a paginated jump-to-letter filter, and collapsible filter chrome — per `docs/superpowers/specs/2026-07-26-books-list-density-design.md`.

**Architecture:** `src/lib/search.ts` gains a `startsWith` prefilter (computed in JS against a lightweight id/title/author scan, since letter-bucketing needs diacritic-stripping that Postgres's default collation doesn't do), three new `sortBy` values, and a `countCatalog` companion query. A new `src/lib/density.ts` + `src/lib/actions/density.ts` pair reads/writes a per-view cookie (`density-books`, `density-home`) via a small server action, since cookie writes require a Server Function in this Next version. `CatalogResultCard` gains a `density` prop with a compact rendering branch; `CatalogFilters` becomes a native `<details>` disclosure. `letterBucket`/its sort order move out of `tbrGap.ts` into a new shared `src/lib/alphabetize.ts`, since both `/tbr` and `/books` now depend on them.

**Tech Stack:** Next.js 16 (App Router, Server Components/Actions), Prisma 7, Postgres, Vitest, Tailwind, Playwright (MCP) for browser verification.

**Non-goals carried from the spec (do not implement):** virtualised lists, changes to `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE`, changes to `/tbr`'s existing jump nav, infinite scroll, or any of the 2026-07-26 UX assessment's accessibility findings. The assessment's `/books/duplicates` unbounded-merge data-loss finding is explicitly out of scope here and tracked separately in memory — do not fold it into this work.

---

### Task 1: Extract `letterBucket`/letter-sort into a shared `alphabetize.ts`

`letterBucket` and the "#"-sorts-last comparator currently live private to `src/lib/tbrGap.ts`. `/books`' jump-to-letter (Task 5) needs the exact same semantics, so they move to a new shared file both `tbrGap.ts` and `search.ts` can import.

**Files:**
- Create: `src/lib/alphabetize.ts`
- Create: `src/lib/alphabetize.test.ts`
- Modify: `src/lib/tbrGap.ts:1-32` (imports + delete the two local definitions), `src/lib/tbrGap.ts:242-247` (`groupByInitial`'s inline sort)

- [ ] **Step 1: Write the failing test for the new module**

Create `src/lib/alphabetize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { letterBucket, sortLetters } from "@/lib/alphabetize";

describe("letterBucket", () => {
  it("returns the uppercased first letter for a plain ASCII string", () => {
    expect(letterBucket("Elantris")).toBe("E");
  });

  it("buckets an accented first letter under its unaccented equivalent", () => {
    expect(letterBucket("Émile Zola")).toBe("E");
  });

  it("buckets a non-letter first character under '#'", () => {
    expect(letterBucket("1984")).toBe("#");
  });

  it("buckets an empty string under '#'", () => {
    expect(letterBucket("")).toBe("#");
  });
});

describe("sortLetters", () => {
  it("sorts letters alphabetically", () => {
    expect(sortLetters(["M", "A", "Z"])).toEqual(["A", "M", "Z"]);
  });

  it("always places '#' last, even before an earlier-inserted letter", () => {
    expect(sortLetters(["#", "A"])).toEqual(["A", "#"]);
  });

  it("returns an empty array for empty input", () => {
    expect(sortLetters([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- alphabetize`
Expected: FAIL — `Cannot find module '@/lib/alphabetize'`

- [ ] **Step 3: Create the module**

Create `src/lib/alphabetize.ts`:

```ts
// Strips diacritics before the A-Z test so bucketing agrees with a
// locale-aware, base-letter-insensitive sort (an author like "Émile Zola"
// sorts among the E's -- it should bucket under "E", not fall through to
// "#" just because its first character isn't plain ASCII). Shared by
// /tbr's jump-nav (tbrGap.ts) and /books' jump-to-letter and startsWith
// filter (search.ts), so both pages agree on what "browsing alphabetically"
// means for a given title/author.
export function letterBucket(key: string): string {
  const normalized = key
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase();
  const firstChar = normalized.charAt(0);
  return /[A-Z]/.test(firstChar) ? firstChar : "#";
}

// "#" (the catch-all for non-letter first characters) always sorts last,
// after every real letter -- matches the jump-nav order both /tbr and
// /books use (A...Z, #).
export function sortLetters(letters: string[]): string[] {
  return [...letters].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- alphabetize`
Expected: PASS (7 tests)

- [ ] **Step 5: Point `tbrGap.ts` at the shared module**

In `src/lib/tbrGap.ts`, replace lines 1-32 (imports through the end of the local `letterBucket` definition) with:

```ts
import { prisma } from "@/lib/prisma";
import { isTitleMatch, normalizeTitle } from "@/lib/matching";
import { normalizeIsbn } from "@/lib/isbn";
import { letterBucket, sortLetters } from "@/lib/alphabetize";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
  coverImagePath: string | null;
  isbn: string | null;
}

// Author (trimmed) if present, else title (trimmed) -- used both to sort the
// full list and to decide which letter bucket an item falls into in
// groupByInitial, so the two always agree on what "browsing alphabetically"
// means for a given item.
function sortKey(item: Pick<TbrGapItem, "title" | "author">): string {
  return item.author?.trim() || item.title.trim();
}
```

(This deletes the local `letterBucket` function entirely — it's now imported.)

Then in `groupByInitial` (originally lines 230-248), replace the trailing sort block:

```ts
  const letters = [...groups.keys()].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  return letters.map((letter) => ({ letter, items: groups.get(letter)! }));
```

with:

```ts
  const letters = sortLetters([...groups.keys()]);
  return letters.map((letter) => ({ letter, items: groups.get(letter)! }));
```

- [ ] **Step 6: Run the full existing tbrGap suite to confirm no regression**

Run: `npm test -- tbrGap`
Expected: PASS — every existing `groupByInitial` test (including the accented-letter and "#"-bucket ones) still passes unchanged, since behavior is identical, just relocated.

- [ ] **Step 7: Commit**

```bash
git add src/lib/alphabetize.ts src/lib/alphabetize.test.ts src/lib/tbrGap.ts
git commit -m "refactor: extract letterBucket/sortLetters into a shared alphabetize module"
```

---

### Task 2: Extract `buildCatalogWhere` and `buildOrderBy` from `searchCatalog`

Pure refactor with no behavior change — the existing `search.test.ts` suite (60+ cases) is the regression net. This unlocks Tasks 3-5, which all need the where-clause and order-by logic outside of `searchCatalog` itself.

**Files:**
- Modify: `src/lib/search.ts:112-231` (`searchCatalog`)

- [ ] **Step 1: Run the existing suite to confirm a clean baseline**

Run: `npm test -- search.test`
Expected: PASS (all existing tests green before touching anything)

- [ ] **Step 2: Replace `searchCatalog` with the extracted-helpers version**

In `src/lib/search.ts`, replace the entire `searchCatalog` function (lines 112-231) with:

```ts
// True when neither text/ISBN search nor any filter is active and the
// caller didn't opt into browsing everything -- the historical "empty
// unfiltered home page" behavior, shared by searchCatalog, countCatalog,
// and getAvailableStartsWithLetters so all three agree on when there's
// nothing to look up.
function hasNoActiveQuery(options: SearchOptions): boolean {
  const trimmed = options.query?.trim() ?? "";
  const statusValues = options.status && options.status.length > 0 ? options.status : undefined;
  return (
    !(options.browseAll ?? false) &&
    !trimmed &&
    !options.types &&
    !options.format &&
    !statusValues
  );
}

export function buildCatalogWhere(options: SearchOptions): Prisma.BookWhereInput {
  const trimmed = options.query?.trim() ?? "";
  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;
  const statusValues = options.status && options.status.length > 0 ? options.status : undefined;

  const includePhysical = !types || types.includes("physical");
  const includeEbook = !types || types.includes("ebook");
  const includeAudiobook = !types || types.includes("audiobook");

  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed);
  const normalizedIsbnQuery = trimmed && looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";

  // See searchCatalog's original comment (preserved here): this OR is only
  // applied as a required filter when the caller explicitly asked for an
  // ownership-narrowed view. A plain, unfiltered text/ISBN search should
  // still surface any matching Book regardless of ownership.
  const explicitOwnershipFilterActive = types !== undefined || format !== undefined;
  const filters: Prisma.BookWhereInput[] = [];
  if (explicitOwnershipFilterActive) {
    const ownershipOr: Prisma.BookWhereInput[] = [];
    if (includePhysical) {
      ownershipOr.push({ copies: format ? { some: { format } } : { some: {} } });
    }
    if (includeEbook) ownershipOr.push({ hasEbook: true });
    if (includeAudiobook) ownershipOr.push({ hasAudiobook: true });
    filters.push({ OR: ownershipOr });
  }
  const statusWhere = buildStatusWhere(statusValues, options.statusMode ?? "or");
  if (statusWhere) filters.push(statusWhere);
  if (trimmed) {
    filters.push({
      OR: [
        { title: { contains: trimmed, mode: "insensitive" as const } },
        { author: { contains: trimmed, mode: "insensitive" as const } },
        ...(normalizedIsbnQuery
          ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
          : []),
      ],
    });
  }

  return { AND: filters };
}

function buildOrderBy(
  sortBy: NonNullable<SearchOptions["sortBy"]>,
): Prisma.BookOrderByWithRelationInput[] {
  switch (sortBy) {
    case "title":
      return [{ title: "asc" }, { id: "asc" }];
    case "id":
    default:
      return [{ id: "asc" }];
  }
}

function fetchBooksWithDetails(
  where: Prisma.BookWhereInput,
  orderBy: Prisma.BookOrderByWithRelationInput[],
  format: Format | undefined,
  take?: number,
) {
  return prisma.book.findMany({
    where,
    include: {
      copies: { where: format ? { format } : undefined },
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy,
    ...(take !== undefined ? { take } : {}),
  });
}

type BookWithDetails = Awaited<ReturnType<typeof fetchBooksWithDetails>>[number];

export async function searchCatalog(options: SearchOptions): Promise<SearchResult[]> {
  if (hasNoActiveQuery(options)) return [];

  // Throws rather than silently ignoring a bad value: dropping an invalid
  // `limit` would turn a caller bug into an unbounded full-catalog query --
  // exactly the performance problem pagination exists to prevent -- and the
  // failure would be invisible until the catalog grew large enough to hurt.
  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`searchCatalog: limit must be a positive integer, received ${limit}`);
  }

  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;
  const includePhysical = !types || types.includes("physical");
  const includeEbook = !types || types.includes("ebook");
  const includeAudiobook = !types || types.includes("audiobook");

  const where = buildCatalogWhere(options);
  const orderBy = buildOrderBy(options.sortBy ?? "id");

  const books: BookWithDetails[] = await fetchBooksWithDetails(where, orderBy, format, limit);

  return books.map((book) => ({
    title: book.title,
    author: book.author,
    bookId: book.id,
    physicalCopies: includePhysical
      ? book.copies.map((copy) => ({
          id: copy.id,
          format: copy.format,
          publisher: copy.publisher,
          publishYear: copy.publishYear,
        }))
      : [],
    hasEbook: includeEbook ? book.hasEbook : false,
    hasAudiobook: includeAudiobook ? book.hasAudiobook : false,
    readStatus: book.readStatus,
    rating: book.rating,
    coverImagePath: resolveListingCover(book),
  }));
}
```

This is behavior-preserving: `buildCatalogWhere` is the exact same filter-building logic, `buildOrderBy` currently only handles the two existing cases, and `fetchBooksWithDetails` is the exact same `prisma.book.findMany` call. `startsWith` handling is deliberately NOT added yet (Task 5).

- [ ] **Step 3: Run the full existing suite to confirm zero regressions**

Run: `npm test -- search.test`
Expected: PASS — every one of the ~60 existing `searchCatalog` tests still passes, since this is a pure extraction.

- [ ] **Step 4: Add two direct tests for the newly-exported `buildCatalogWhere`**

Add to `src/lib/search.test.ts`, after the `buildStatusWhere` describe block:

```ts
describe("buildCatalogWhere", () => {
  it("returns an empty AND for no filters and no query", () => {
    expect(buildCatalogWhere({})).toEqual({ AND: [] });
  });

  it("combines a text query and a types filter into separate AND clauses", () => {
    const where = buildCatalogWhere({ query: "dune", types: ["ebook"] });
    expect(where.AND).toHaveLength(2);
  });
});
```

Add `buildCatalogWhere` to the existing import list at the top of `src/lib/search.test.ts`.

- [ ] **Step 5: Run to verify the new tests pass**

Run: `npm test -- search.test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "refactor: extract buildCatalogWhere/buildOrderBy from searchCatalog"
```

---

### Task 3: Extend `sortBy` with `author`, `createdAt`, `rating`

**Files:**
- Modify: `src/lib/search.ts` (`SearchOptions.sortBy` type, `buildOrderBy`)
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/search.test.ts`, inside (or right after) the existing sort-related tests in the `searchCatalog` describe block:

```ts
  it("sorts by author ascending when sortBy is 'author', with authorless books last", async () => {
    await prisma.book.create({ data: { title: "Test Search Author Sort No Author" } });
    await prisma.book.create({ data: { title: "Test Search Author Sort Zed", author: "Zed" } });
    await prisma.book.create({ data: { title: "Test Search Author Sort Amy", author: "Amy" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "author" });

    const ours = results.filter((r) => r.title.startsWith("Test Search Author Sort"));
    expect(ours.map((r) => r.title)).toEqual([
      "Test Search Author Sort Amy",
      "Test Search Author Sort Zed",
      "Test Search Author Sort No Author",
    ]);
  });

  it("breaks author-sort ties by title, then keeps a stable order across repeated calls", async () => {
    await prisma.book.create({ data: { title: "Test Search Author Tie B", author: "Same Author" } });
    await prisma.book.create({ data: { title: "Test Search Author Tie A", author: "Same Author" } });

    const first = await searchCatalog({ browseAll: true, sortBy: "author" });
    const second = await searchCatalog({ browseAll: true, sortBy: "author" });

    const titlesFirst = first
      .filter((r) => r.title.startsWith("Test Search Author Tie"))
      .map((r) => r.title);
    const titlesSecond = second
      .filter((r) => r.title.startsWith("Test Search Author Tie"))
      .map((r) => r.title);
    expect(titlesFirst).toEqual(["Test Search Author Tie A", "Test Search Author Tie B"]);
    expect(titlesSecond).toEqual(titlesFirst);
  });

  it("sorts by createdAt descending when sortBy is 'createdAt'", async () => {
    const first = await prisma.book.create({ data: { title: "Test Search Created First" } });
    await new Promise((r) => setTimeout(r, 5));
    const second = await prisma.book.create({ data: { title: "Test Search Created Second" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "createdAt" });

    const ours = results.filter((r) => r.bookId === first.id || r.bookId === second.id);
    expect(ours.map((r) => r.bookId)).toEqual([second.id, first.id]);
  });

  it("sorts by rating descending when sortBy is 'rating', with unrated books last", async () => {
    await prisma.book.create({ data: { title: "Test Search Rating Sort Unrated" } });
    await prisma.book.create({ data: { title: "Test Search Rating Sort Three", rating: 3 } });
    await prisma.book.create({ data: { title: "Test Search Rating Sort Five", rating: 5 } });

    const results = await searchCatalog({ browseAll: true, sortBy: "rating" });

    const ours = results.filter((r) => r.title.startsWith("Test Search Rating Sort"));
    expect(ours.map((r) => r.title)).toEqual([
      "Test Search Rating Sort Five",
      "Test Search Rating Sort Three",
      "Test Search Rating Sort Unrated",
    ]);
  });

  it("applies sort before the limit, not after", async () => {
    await prisma.book.create({ data: { title: "Test Search Sort Before Limit Zebra" } });
    await prisma.book.create({ data: { title: "Test Search Sort Before Limit Mango" } });
    await prisma.book.create({ data: { title: "Test Search Sort Before Limit Apple" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "title", limit: 2 });

    const ours = results
      .filter((r) => r.title.startsWith("Test Search Sort Before Limit"))
      .map((r) => r.title);
    // Of the full sorted order (Apple, Mango, Zebra), the first two -- not
    // two arbitrary rows re-sorted after an arbitrary limit.
    expect(ours).toEqual(["Test Search Sort Before Limit Apple", "Test Search Sort Before Limit Mango"]);
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test -- search.test`
Expected: FAIL — TypeScript rejects `sortBy: "author"` etc. (not assignable to `"id" | "title"`), or at minimum the sort order assertions fail since `buildOrderBy`'s default branch is hit for unrecognized values.

- [ ] **Step 3: Extend the type and `buildOrderBy`**

In `src/lib/search.ts`, change the `SearchOptions` interface's `sortBy` line:

```ts
  sortBy?: "id" | "title" | "author" | "createdAt" | "rating";
```

And extend `buildOrderBy`:

```ts
function buildOrderBy(
  sortBy: NonNullable<SearchOptions["sortBy"]>,
): Prisma.BookOrderByWithRelationInput[] {
  switch (sortBy) {
    case "title":
      return [{ title: "asc" }, { id: "asc" }];
    case "author":
      return [{ author: { sort: "asc", nulls: "last" } }, { title: "asc" }, { id: "asc" }];
    case "createdAt":
      return [{ createdAt: "desc" }, { id: "desc" }];
    case "rating":
      return [{ rating: { sort: "desc", nulls: "last" } }, { title: "asc" }, { id: "asc" }];
    case "id":
    default:
      return [{ id: "asc" }];
  }
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm test -- search.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add author/createdAt/rating sort options to searchCatalog"
```

---

### Task 4: Add `countCatalog`

**Files:**
- Modify: `src/lib/search.ts`
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `src/lib/search.test.ts`:

```ts
describe("countCatalog", () => {
  it("matches the number of rows searchCatalog returns unpaginated, for the same filters", async () => {
    await prisma.book.create({ data: { title: "Test Search Count One" } });
    await prisma.book.create({ data: { title: "Test Search Count Two" } });

    const results = await searchCatalog({ query: "Test Search Count" });
    const count = await countCatalog({ query: "Test Search Count" });

    expect(count).toBe(results.length);
  });

  it("is independent of limit", async () => {
    await prisma.book.create({ data: { title: "Test Search Count Limit One" } });
    await prisma.book.create({ data: { title: "Test Search Count Limit Two" } });
    await prisma.book.create({ data: { title: "Test Search Count Limit Three" } });

    const count = await countCatalog({ query: "Test Search Count Limit", limit: 1 });

    expect(count).toBe(3);
  });

  it("returns 0 when there is no query and no filters (matching searchCatalog's empty behavior)", async () => {
    expect(await countCatalog({})).toBe(0);
  });

  it("respects browseAll", async () => {
    const before = await countCatalog({ browseAll: true });
    await prisma.book.create({ data: { title: "Test Search Count Browse All" } });

    expect(await countCatalog({ browseAll: true })).toBe(before + 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- search.test`
Expected: FAIL — `countCatalog is not a function`

- [ ] **Step 3: Implement `countCatalog`**

Add to `src/lib/search.ts`, after `searchCatalog`:

```ts
export async function countCatalog(options: SearchOptions): Promise<number> {
  if (hasNoActiveQuery(options)) return 0;
  const where = buildCatalogWhere(options);
  return prisma.book.count({ where });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- search.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add countCatalog for /books' result-count line"
```

---

### Task 5: Add the `startsWith` letter filter, and `getAvailableStartsWithLetters`

A letter filter isn't SQL-expressible the way this project needs it (matching `letterBucket`'s diacritic-stripped semantics, which Postgres's default collation doesn't do), so it's applied in JS against a lightweight `id`/`title`/`author`-only scan, and the real detail query is then scoped to just the matching ids. This also updates `countCatalog` to handle the letter filter, and adds `getAvailableStartsWithLetters` for rendering the jump-nav itself.

**Files:**
- Modify: `src/lib/search.ts`
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `import { letterBucket } from "@/lib/alphabetize";` is NOT needed in the test file (tests call the public API only). Add to `src/lib/search.test.ts`:

```ts
describe("searchCatalog startsWith filter", () => {
  it("returns only books whose title starts with the given letter, under title sort", async () => {
    await prisma.book.create({ data: { title: "Test Search Letter Mistborn" } });
    await prisma.book.create({ data: { title: "Test Search Letter Elantris" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      startsWith: { letter: "M", field: "title" },
    });

    const ours = results.filter((r) => r.title.startsWith("Test Search Letter"));
    expect(ours.map((r) => r.title)).toEqual(["Test Search Letter Mistborn"]);
  });

  it("filters on author, not title, when field is 'author'", async () => {
    await prisma.book.create({ data: { title: "Test Search Letter Author A", author: "Zed Author" } });
    await prisma.book.create({ data: { title: "Test Search Letter Author B", author: "Amy Author" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "author",
      startsWith: { letter: "Z", field: "author" },
    });

    const ours = results.filter((r) => r.title.startsWith("Test Search Letter Author"));
    expect(ours.map((r) => r.title)).toEqual(["Test Search Letter Author A"]);
  });

  it("buckets a diacritic-initial author under its unaccented letter", async () => {
    await prisma.book.create({
      data: { title: "Test Search Letter Diacritic Book", author: "Émile Diacritic Zola" },
    });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "author",
      startsWith: { letter: "E", field: "author" },
    });

    expect(results.map((r) => r.title)).toContain("Test Search Letter Diacritic Book");
  });

  it("buckets a non-letter first character under '#'", async () => {
    await prisma.book.create({ data: { title: "1984 Test Search Letter Hash" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      startsWith: { letter: "#", field: "title" },
    });

    expect(results.map((r) => r.title)).toContain("1984 Test Search Letter Hash");
  });

  it("combines the letter filter with an existing types filter", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Letter Combo Mistborn",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "search-test-letter-combo-ebook" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Search Letter Combo Man In The High Castle",
        copies: { create: { format: "PAPERBACK" } },
      },
    });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      types: ["ebook"],
      startsWith: { letter: "M", field: "title" },
    });

    expect(results.map((r) => r.title)).toContain("Test Search Letter Combo Mistborn");
    expect(results.map((r) => r.title)).not.toContain(
      "Test Search Letter Combo Man In The High Castle",
    );
  });

  it("applies the letter filter and sort before the limit", async () => {
    await prisma.book.create({ data: { title: "Test Search Letter Limit Mango" } });
    await prisma.book.create({ data: { title: "Test Search Letter Limit Mars" } });
    await prisma.book.create({ data: { title: "Test Search Letter Limit Zebra" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      startsWith: { letter: "M", field: "title" },
      limit: 1,
    });

    const ours = results.filter((r) => r.title.startsWith("Test Search Letter Limit"));
    expect(ours.map((r) => r.title)).toEqual(["Test Search Letter Limit Mango"]);
  });
});

describe("countCatalog with a startsWith filter", () => {
  it("counts only the letter-matching rows, independent of limit", async () => {
    await prisma.book.create({ data: { title: "Test Search Count Letter Mango" } });
    await prisma.book.create({ data: { title: "Test Search Count Letter Mars" } });
    await prisma.book.create({ data: { title: "Test Search Count Letter Zebra" } });

    const count = await countCatalog({
      query: "Test Search Count Letter",
      sortBy: "title",
      startsWith: { letter: "M", field: "title" },
      limit: 1,
    });

    expect(count).toBe(2);
  });
});

describe("getAvailableStartsWithLetters", () => {
  it("returns the distinct sorted letters present, ignoring any active startsWith", async () => {
    await prisma.book.create({ data: { title: "Test Search Letters Available Mango" } });
    await prisma.book.create({ data: { title: "Test Search Letters Available Zebra" } });

    const letters = await getAvailableStartsWithLetters(
      { query: "Test Search Letters Available", browseAll: false },
      "title",
    );

    expect(letters).toEqual(["M", "Z"]);
  });

  it("returns an empty array when nothing matches", async () => {
    const letters = await getAvailableStartsWithLetters(
      { query: "Test Search Letters Nonexistent Zzzzz" },
      "title",
    );

    expect(letters).toEqual([]);
  });
});
```

Add `countCatalog` and `getAvailableStartsWithLetters` to the test file's import list.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm test -- search.test`
Expected: FAIL — `startsWith` isn't a recognized `SearchOptions` key yet, and `getAvailableStartsWithLetters` doesn't exist.

- [ ] **Step 3: Implement**

In `src/lib/search.ts`:

1. Add the import at the top:

```ts
import { letterBucket, sortLetters } from "@/lib/alphabetize";
```

2. Extend `SearchOptions`:

```ts
export interface SearchOptions {
  query?: string;
  types?: OwnershipType[];
  format?: Format;
  status?: ReadStatusFilterValue[];
  statusMode?: StatusFilterMode;
  browseAll?: boolean;
  sortBy?: "id" | "title" | "author" | "createdAt" | "rating";
  // Not SQL-expressible against this schema's default collation (see the
  // module comment above resolveStartsWithIds) -- applied in JS.
  startsWith?: { letter: string; field: "title" | "author" };
  limit?: number;
}
```

3. Add, after `fetchBooksWithDetails`/`BookWithDetails`:

```ts
// A letter filter can't be pushed into the SQL WHERE clause: it depends on
// letterBucket's diacritic-stripping (see alphabetize.ts), and Postgres's
// default collation doesn't fold accents the way ILIKE would need to for
// that to work. Instead this scans a lightweight id/title/author-only
// projection (no joins -- cheap even at full-catalog scale, the same shape
// as the 3ms-median aggregate queries measured for /stats against a
// 2000-book fixture), buckets each row in JS, and returns the matching ids
// in the query's own sort order.
async function resolveStartsWithIds(
  startsWith: { letter: string; field: "title" | "author" },
  where: Prisma.BookWhereInput,
  orderBy: Prisma.BookOrderByWithRelationInput[],
): Promise<string[]> {
  const rows = await prisma.book.findMany({
    where,
    select: { id: true, title: true, author: true },
    orderBy,
  });
  return rows
    .filter(
      (row) =>
        letterBucket(startsWith.field === "title" ? row.title : (row.author ?? "")) ===
        startsWith.letter,
    )
    .map((row) => row.id);
}
```

4. Replace `searchCatalog`'s body from `const books: BookWithDetails[] = ...` onward with:

```ts
  let books: BookWithDetails[];
  if (options.startsWith) {
    const ids = await resolveStartsWithIds(options.startsWith, where, orderBy);
    const pageIds = limit !== undefined ? ids.slice(0, limit) : ids;
    if (pageIds.length === 0) {
      books = [];
    } else {
      const rows = await fetchBooksWithDetails(
        { AND: [where, { id: { in: pageIds } }] },
        orderBy,
        format,
      );
      // Prisma's `id: { in: ... }` does not preserve the given array's
      // order, so the already-correctly-sorted `pageIds` order is restored.
      const byId = new Map(rows.map((row) => [row.id, row]));
      books = pageIds
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined);
    }
  } else {
    books = await fetchBooksWithDetails(where, orderBy, format, limit);
  }
```

(The final `return books.map(...)` stays unchanged.)

5. Update `countCatalog`:

```ts
export async function countCatalog(options: SearchOptions): Promise<number> {
  if (hasNoActiveQuery(options)) return 0;
  const where = buildCatalogWhere(options);
  if (options.startsWith) {
    const orderBy = buildOrderBy(options.sortBy ?? "id");
    const ids = await resolveStartsWithIds(options.startsWith, where, orderBy);
    return ids.length;
  }
  return prisma.book.count({ where });
}
```

6. Add `getAvailableStartsWithLetters`, after `countCatalog`:

```ts
// The set of letters that currently have at least one match, for rendering
// the jump-nav itself -- deliberately ignores `options.startsWith` (the
// nav must keep listing every available letter, not collapse to just the
// one currently selected).
export async function getAvailableStartsWithLetters(
  options: SearchOptions,
  field: "title" | "author",
): Promise<string[]> {
  if (hasNoActiveQuery(options)) return [];
  const where = buildCatalogWhere(options);
  const rows = await prisma.book.findMany({ where, select: { title: true, author: true } });
  const letters = new Set(
    rows.map((row) => letterBucket(field === "title" ? row.title : (row.author ?? ""))),
  );
  return sortLetters([...letters]);
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm test -- search.test`
Expected: PASS

- [ ] **Step 5: Run the FULL existing suite once more to confirm no regression**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add startsWith letter filter and getAvailableStartsWithLetters"
```

---

### Task 6: Add `parseSortParam` and `parseStartsWithLetter` URL-param parsers

Mirrors the existing `parseFormatParam`/`parseTypesParam`/`parseStatusParam` pattern: malformed or unrecognized values fall back to a safe default rather than erroring.

**Files:**
- Modify: `src/lib/search.ts`
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/search.test.ts`:

```ts
describe("parseSortParam", () => {
  it("returns 'title' for an undefined value", () => {
    expect(parseSortParam(undefined)).toBe("title");
  });

  it("returns the value for each valid sort", () => {
    expect(parseSortParam("title")).toBe("title");
    expect(parseSortParam("author")).toBe("author");
    expect(parseSortParam("createdAt")).toBe("createdAt");
    expect(parseSortParam("rating")).toBe("rating");
  });

  it("falls back to 'title' for an unrecognized value", () => {
    expect(parseSortParam("bogus")).toBe("title");
  });

  it("falls back to 'title' for 'id' (not a user-facing sort option)", () => {
    expect(parseSortParam("id")).toBe("title");
  });
});

describe("parseStartsWithLetter", () => {
  it("returns undefined for an undefined or empty value", () => {
    expect(parseStartsWithLetter(undefined)).toBeUndefined();
    expect(parseStartsWithLetter("")).toBeUndefined();
  });

  it("uppercases a valid single letter", () => {
    expect(parseStartsWithLetter("m")).toBe("M");
  });

  it("accepts '#'", () => {
    expect(parseStartsWithLetter("#")).toBe("#");
  });

  it("returns undefined for anything else (multi-char, digit, symbol)", () => {
    expect(parseStartsWithLetter("mm")).toBeUndefined();
    expect(parseStartsWithLetter("5")).toBeUndefined();
    expect(parseStartsWithLetter("$")).toBeUndefined();
  });
});
```

Add `parseSortParam` and `parseStartsWithLetter` to the import list.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- search.test`
Expected: FAIL — both functions undefined.

- [ ] **Step 3: Implement**

Add to `src/lib/search.ts`, near the other `parse*` functions:

```ts
const VALID_SORT_VALUES = ["title", "author", "createdAt", "rating"] as const;

export function parseSortParam(
  value: string | undefined,
): "title" | "author" | "createdAt" | "rating" {
  return value && (VALID_SORT_VALUES as readonly string[]).includes(value)
    ? (value as "title" | "author" | "createdAt" | "rating")
    : "title";
}

export function parseStartsWithLetter(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value === "#" || /^[A-Za-z]$/.test(value) ? value.toUpperCase() : undefined;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- search.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add parseSortParam/parseStartsWithLetter URL param parsers"
```

---

### Task 7: `src/lib/density.ts` — per-view density cookie

**Files:**
- Create: `src/lib/density.ts`
- Create: `src/lib/density.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/density.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
  }),
}));

import { getDensity, densityCookieName } from "@/lib/density";

beforeEach(() => {
  cookieStore.clear();
});

describe("getDensity", () => {
  it("defaults to compact for the books view when no cookie is set", async () => {
    expect(await getDensity("books")).toBe("compact");
  });

  it("defaults to comfortable for the home view when no cookie is set", async () => {
    expect(await getDensity("home")).toBe("comfortable");
  });

  it("honors a stored cookie value over the default", async () => {
    cookieStore.set(densityCookieName("books"), "comfortable");
    expect(await getDensity("books")).toBe("comfortable");
  });

  it("falls back to the default for a garbage cookie value", async () => {
    cookieStore.set(densityCookieName("home"), "bogus");
    expect(await getDensity("home")).toBe("comfortable");
  });

  it("uses a distinct cookie name per view", () => {
    expect(densityCookieName("books")).not.toBe(densityCookieName("home"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- density`
Expected: FAIL — `Cannot find module '@/lib/density'`

- [ ] **Step 3: Implement**

Create `src/lib/density.ts`:

```ts
import { cookies } from "next/headers";

export type Density = "comfortable" | "compact";
export type DensityView = "books" | "home";

// Per the design spec: /books defaults to compact (browsing a large
// library), / defaults to comfortable (confirming a single edition, where
// the larger cover is doing real work).
const DEFAULTS: Record<DensityView, Density> = {
  books: "compact",
  home: "comfortable",
};

export function densityCookieName(view: DensityView): string {
  return `density-${view}`;
}

// Cookie rather than localStorage: this app is server-component-first, so
// reading the cookie during render means the correct density is in the
// FIRST HTML response -- no hydration flash, no client state library.
export async function getDensity(view: DensityView): Promise<Density> {
  const store = await cookies();
  const value = store.get(densityCookieName(view))?.value;
  return value === "comfortable" || value === "compact" ? value : DEFAULTS[view];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- density`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/density.ts src/lib/density.test.ts
git commit -m "feat: add per-view density cookie reader"
```

---

### Task 8: `src/lib/actions/density.ts` — the toggle's server action

Cookie writes require a Server Function in this Next version (verified against `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`: "Setting cookies is not supported during Server Component rendering"). No test file — matches this codebase's existing convention that thin action wrappers in `src/lib/actions/` aren't unit-tested (their logic is either trivial or already covered by the data-layer function they call); this one is verified in Task 13's browser pass instead.

**Files:**
- Create: `src/lib/actions/density.ts`

- [ ] **Step 1: Implement**

Create `src/lib/actions/density.ts`:

```ts
"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { densityCookieName, type Density, type DensityView } from "@/lib/density";

const VIEW_PATHS: Record<DensityView, string> = {
  books: "/books",
  home: "/",
};

export async function setDensity(view: DensityView, density: Density): Promise<void> {
  const store = await cookies();
  store.set(densityCookieName(view), density, {
    // A single-user personal app has no session boundary this should
    // expire at -- effectively "remember until they change it again".
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  revalidatePath(VIEW_PATHS[view]);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/density.ts
git commit -m "feat: add setDensity server action"
```

---

### Task 9: `CoverThumbnail` gains a `size` variant

**Files:**
- Modify: `src/components/CoverThumbnail.tsx`
- Modify: `src/app/tbr/page.tsx:77` (preserve its current spacing after the prop contract changes)
- Modify: `src/components/CatalogResultCard.tsx:63` (same)

No dedicated test file — this component has none today (it's pure JSX), and the codebase's convention is real-browser verification for rendering (Task 13), not DOM tests for presentational components.

- [ ] **Step 1: Replace `CoverThumbnail`**

Replace the full contents of `src/components/CoverThumbnail.tsx`:

```tsx
const SIZE_CLASSES = {
  default: "h-32 w-24",
  compact: "h-16 w-12",
} as const;

interface CoverThumbnailProps {
  coverImagePath: string | null;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
}

export function CoverThumbnail({
  coverImagePath,
  size = "default",
  className = "",
}: CoverThumbnailProps) {
  const sizeClass = SIZE_CLASSES[size];

  if (!coverImagePath) {
    return (
      <div
        className={`flex ${sizeClass} shrink-0 items-center justify-center rounded border border-dashed border-perforation bg-surface text-3xl text-foreground/40 ${className}`}
        aria-hidden="true"
      >
        📖
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/covers/${encodeURIComponent(coverImagePath)}`}
      alt="Cover"
      className={`${sizeClass} shrink-0 rounded object-cover ${className}`}
    />
  );
}
```

This drops the hardcoded `mb-2` (which only made sense when every caller stacked the cover above text) in favor of a `className` passthrough, and adds `shrink-0` so the cover can't be squeezed by a flex sibling in the new compact row layout.

- [ ] **Step 2: Preserve existing spacing at both current call sites**

In `src/app/tbr/page.tsx:77`, change:

```tsx
                <CoverThumbnail coverImagePath={item.coverImagePath} />
```

to:

```tsx
                <CoverThumbnail coverImagePath={item.coverImagePath} className="mb-2" />
```

In `src/components/CatalogResultCard.tsx:63`, change:

```tsx
      <CoverThumbnail coverImagePath={result.coverImagePath} />
```

to:

```tsx
      <CoverThumbnail coverImagePath={result.coverImagePath} className="mb-2" />
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/CoverThumbnail.tsx src/app/tbr/page.tsx src/components/CatalogResultCard.tsx
git commit -m "feat: add a compact size variant to CoverThumbnail"
```

---

### Task 10: `CatalogResultCard` gains a `density` prop and compact row

Extracts the existing meta-parts-building logic into an exported, independently-testable `buildMetaParts` function (following this codebase's convention of unit-testing pure logic pulled out of otherwise-JSX component files, e.g. `ReadingProgressFields.test.ts`'s `ratingStars`).

**Files:**
- Modify: `src/components/CatalogResultCard.tsx`
- Create: `src/components/CatalogResultCard.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/components/CatalogResultCard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildMetaParts } from "@/components/CatalogResultCard";
import type { SearchResult } from "@/lib/search";

function baseResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "Test Book",
    author: "Test Author",
    bookId: "book-1",
    physicalCopies: [],
    hasEbook: false,
    hasAudiobook: false,
    readStatus: null,
    rating: null,
    coverImagePath: null,
    ...overrides,
  };
}

describe("buildMetaParts", () => {
  it("includes publisher and year for a physical copy in comfortable density", () => {
    const parts = buildMetaParts(
      baseResult({
        physicalCopies: [{ id: "c1", format: "PAPERBACK", publisher: "Tor", publishYear: 2010 }],
      }),
      "comfortable",
    );
    expect(parts.find((p) => p.key === "physical-c1")?.label).toBe("Paperback, Tor 2010");
  });

  it("omits publisher and year for a physical copy in compact density", () => {
    const parts = buildMetaParts(
      baseResult({
        physicalCopies: [{ id: "c1", format: "PAPERBACK", publisher: "Tor", publishYear: 2010 }],
      }),
      "compact",
    );
    expect(parts.find((p) => p.key === "physical-c1")?.label).toBe("Paperback");
  });

  it("includes ebook/audiobook/status/rating parts identically in both densities", () => {
    const result = baseResult({
      hasEbook: true,
      hasAudiobook: true,
      readStatus: "READ",
      rating: 4,
    });
    const comfortable = buildMetaParts(result, "comfortable");
    const compact = buildMetaParts(result, "compact");
    expect(comfortable.map((p) => p.key)).toEqual(["ebook", "audiobook", "status", "rating"]);
    expect(compact.map((p) => p.key)).toEqual(["ebook", "audiobook", "status", "rating"]);
  });

  it("returns an empty array when there is nothing to show", () => {
    expect(buildMetaParts(baseResult(), "comfortable")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- CatalogResultCard`
Expected: FAIL — `buildMetaParts` isn't exported yet.

- [ ] **Step 3: Replace `CatalogResultCard.tsx`**

Replace the full contents of `src/components/CatalogResultCard.tsx`:

```tsx
import Link from "next/link";
import type { ReadStatus } from "@prisma/client";
import type { SearchResult } from "@/lib/search";
import type { Density } from "@/lib/density";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_LABELS, ratingStars } from "@/components/ReadingProgressFields";
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { PandaStamp } from "@/components/PandaStamp";
import { TicketCard, TicketDivider } from "@/components/ui/TicketCard";

// `satisfies` (rather than `: Record<string, string>`) means a future
// ReadStatus enum value that's added to the Prisma schema but forgotten here
// fails at compile time instead of silently producing an undefined
// className at runtime.
const STATUS_CLASS = {
  READ: "text-status-positive",
  READING: "text-status-active",
  TO_READ: "text-foreground/70",
} satisfies Record<ReadStatus, string>;

export interface MetaPart {
  key: string;
  label: string;
  className?: string;
  ariaLabel?: string;
}

// Comfortable shows each physical copy's publisher/year; compact strips
// that down to just the format name -- per the design spec, publisher/year
// is "the bulk of today's meta line and rarely what you scan for".
export function buildMetaParts(result: SearchResult, density: Density): MetaPart[] {
  return [
    ...result.physicalCopies.map((copy) => ({
      key: `physical-${copy.id}`,
      label:
        density === "comfortable"
          ? `${FORMAT_LABELS[copy.format]}${copy.publisher ? `, ${copy.publisher}` : ""}${copy.publishYear ? ` ${copy.publishYear}` : ""}`
          : FORMAT_LABELS[copy.format],
    })),
    ...(result.hasEbook ? [{ key: "ebook", label: "Ebook" }] : []),
    ...(result.hasAudiobook ? [{ key: "audiobook", label: "Audiobook" }] : []),
    ...(result.readStatus
      ? [
          {
            key: "status",
            label: READ_STATUS_LABELS[result.readStatus],
            className: STATUS_CLASS[result.readStatus],
          },
        ]
      : []),
    ...(result.rating !== null
      ? [
          {
            key: "rating",
            label: ratingStars(result.rating),
            ariaLabel: `Rated ${result.rating} out of 5`,
          },
        ]
      : []),
  ];
}

// One catalog entry as rendered in a search/browse result list -- shared
// between the home page's unified search and /books' "All Books" browse
// view. `density` defaults to "comfortable" (the home page's own default;
// /books passes its own cookie-backed value explicitly).
export function CatalogResultCard({
  result,
  density = "comfortable",
}: {
  result: SearchResult;
  density?: Density;
}) {
  const metaParts = buildMetaParts(result, density);

  if (density === "compact") {
    const rowClassName =
      "relative flex items-center gap-3 rounded-xl border border-dashed border-perforation bg-surface p-2";
    const content = (
      <>
        {result.readStatus === "READ" && (
          <PandaStamp
            title="Read"
            className="absolute right-2 top-2 h-4 w-4 text-status-positive"
          />
        )}
        <CoverThumbnail coverImagePath={result.coverImagePath} size="compact" />
        <div className="min-w-0 flex-1">
          <p
            className="truncate font-display font-semibold text-foreground-strong"
            title={result.title}
          >
            {result.title}
          </p>
          {result.author && <p className="truncate text-sm text-foreground/70">{result.author}</p>}
          {metaParts.length > 0 && (
            <p className="flex flex-wrap items-center font-mono text-xs uppercase tracking-wide text-foreground/70">
              {metaParts.map((part, index) => (
                <span key={part.key} className={part.className} aria-label={part.ariaLabel}>
                  {index > 0 && <span className="mx-1 text-foreground/40">·</span>}
                  {part.label}
                </span>
              ))}
            </p>
          )}
        </div>
      </>
    );

    return (
      <li data-testid="catalog-row">
        {result.bookId ? (
          <Link href={`/books/${result.bookId}`} className={rowClassName}>
            {content}
          </Link>
        ) : (
          <div className={rowClassName}>{content}</div>
        )}
      </li>
    );
  }

  return (
    <TicketCard className="relative p-3" data-testid="catalog-row">
      {result.readStatus === "READ" && (
        <PandaStamp title="Read" className="absolute right-3 top-3 h-5 w-5 text-status-positive" />
      )}
      <CoverThumbnail coverImagePath={result.coverImagePath} className="mb-2" />
      <p className="font-display font-semibold text-foreground-strong">{result.title}</p>
      {result.author && <p className="text-sm text-foreground/70">{result.author}</p>}
      {metaParts.length > 0 && (
        <>
          <TicketDivider />
          <p className="flex flex-wrap items-center font-mono text-xs uppercase tracking-wide text-foreground/70">
            {metaParts.map((part, index) => (
              <span key={part.key} className={part.className} aria-label={part.ariaLabel}>
                {index > 0 && <span className="mx-1 text-foreground/40">·</span>}
                {part.label}
              </span>
            ))}
          </p>
        </>
      )}
      {result.bookId && (
        <Link href={`/books/${result.bookId}`} className="mt-2 inline-block text-sm text-link underline">
          View details
        </Link>
      )}
    </TicketCard>
  );
}
```

`data-testid="catalog-row"` on both branches is a stable hook for Task 13's row-pitch measurement.

- [ ] **Step 4: Run to verify the tests pass**

Run: `npm test -- CatalogResultCard`
Expected: PASS (4 tests)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, all suites (this changes a shared component, so re-run everything).

- [ ] **Step 6: Commit**

```bash
git add src/components/CatalogResultCard.tsx src/components/CatalogResultCard.test.ts
git commit -m "feat: add a compact row density to CatalogResultCard"
```

---

### Task 11: `CatalogFilters` becomes a collapsible `<details>`

Native disclosure widget — no client JS needed, consistent with this app's server-component-first bias. The submit button moves OUT of `CatalogFilters` (both call sites add their own, outside the collapsible region), since the spec requires the search box, sort control, and result count to "stay always-visible" even when the filter block is collapsed — a submit button trapped inside collapsed `<details>` content would make that impossible.

**Files:**
- Modify: `src/components/CatalogFilters.tsx`

- [ ] **Step 1: Replace `CatalogFilters.tsx`**

Replace the full contents:

```tsx
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
  // Whether at least one filter is currently active -- when true the
  // block renders expanded (a filtered list that LOOKS unfiltered is worse
  // than the height it saves); when false it collapses to a one-line
  // "Filters" summary, which is why /books' first screen was showing only
  // 2 books despite a 900px viewport.
  defaultOpen: boolean;
}

// The ownership-type/status/format filter row shared between the home
// page's unified search and /books' "All Books" browse view. Rendered
// inside each page's own <form>, alongside that page's own
// SearchAutocomplete and its own submit button (a submit button living
// here would be unreachable while collapsed).
export function CatalogFilters({ types, status, statusMode, format, defaultOpen }: CatalogFiltersProps) {
  return (
    <details open={defaultOpen}>
      <summary className="cursor-pointer select-none text-sm text-foreground/70">Filters</summary>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-foreground">
        {OWNERSHIP_TYPE_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-center gap-1">
            <input
              type="checkbox"
              name="types"
              value={opt.value}
              defaultChecked={types?.includes(opt.value) ?? false}
              className="accent-accent"
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
              className="accent-accent"
            />
            {opt.label}
          </label>
        ))}
        <span className="flex items-center gap-1 text-foreground/70">
          Match:
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="statusMode"
              value="or"
              defaultChecked={statusMode === "or"}
              className="accent-accent"
            />
            Any
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="statusMode"
              value="and"
              defaultChecked={statusMode === "and"}
              className="accent-accent"
            />
            All
          </label>
        </span>
        <select
          name="format"
          defaultValue={format ?? ""}
          className="rounded-lg border border-perforation bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          aria-label="Filter by physical format"
        >
          <option value="">Any format</option>
          {FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </details>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: errors at both call sites (`src/app/page.tsx`, `src/app/books/page.tsx`) — `defaultOpen` is now required, and both still expect a `Button` import that's no longer used inside `CatalogFilters`. These are resolved in Tasks 12-13, which rewire both pages. This is expected and acceptable mid-plan (a single logical change spanning a shared component and its two callers).

- [ ] **Step 3: Commit**

```bash
git add src/components/CatalogFilters.tsx
git commit -m "feat: make CatalogFilters a collapsible details widget"
```

(Type errors from the two callers are fixed in the very next tasks, which touch those files directly — commit now to keep this a single-purpose, revertable change.)

---

### Task 12: Wire `/books/page.tsx` — sort, count, jump-to-letter, density, collapsible filters

**Files:**
- Modify: `src/app/books/page.tsx`

- [ ] **Step 1: Replace `src/app/books/page.tsx`**

Replace the full file:

```tsx
import Link from "next/link";
import {
  searchCatalog,
  countCatalog,
  getAvailableStartsWithLetters,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
  parseSortParam,
  parseStartsWithLetter,
} from "@/lib/search";
import { getDensity } from "@/lib/density";
import { setDensity } from "@/lib/actions/density";
import { CatalogFilters } from "@/components/CatalogFilters";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { Button, BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

const DEFAULT_PAGE_SIZE = 50;

// Hard ceiling on ?limit=. "Load more" accumulates server-side -- each click
// re-renders every row from the start, not just the new batch -- so without a
// cap, enough clicks (or a hand-typed ?limit=100000) rebuild the exact
// unpaginated full-catalog render this page was paginated to avoid. 500 rows
// is roughly 1.2MB of HTML, an acceptable worst case; past that, searching or
// filtering is the right tool, and the UI says so rather than silently
// offering a button that can't advance.
const MAX_PAGE_SIZE = 500;

const SORT_OPTIONS = [
  { value: "title", label: "Title A–Z" },
  { value: "author", label: "Author A–Z" },
  { value: "createdAt", label: "Recently added" },
  { value: "rating", label: "Rating high→low" },
] as const;

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
    sort?: string;
    startsWith?: string;
    limit?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
    sort: sortParam,
    startsWith: startsWithParam,
    limit: limitParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);
  const sortBy = parseSortParam(sortParam);
  // Jump-to-letter only makes sense under an alphabetical sort (see the
  // design spec's Jump-to-letter section) -- a hand-typed ?startsWith=
  // under "recently added" or "rating" is silently ignored, matching every
  // other parse* helper's treatment of an inapplicable/malformed param.
  const supportsLetterJump = sortBy === "title" || sortBy === "author";
  const letterField = sortBy === "author" ? "author" : "title";
  const activeLetter = supportsLetterJump ? parseStartsWithLetter(startsWithParam) : undefined;

  const density = await getDensity("books");
  const hasActiveFilters = Boolean(query || types || format || status);

  // Number() rather than parseInt() so partially-numeric junk ("50abc") is
  // rejected outright instead of silently becoming 50. Anything not a
  // positive integer falls back to the default; anything above the ceiling is
  // clamped rather than rejected, so an over-large ?limit= still renders a
  // sane page instead of erroring.
  const parsedLimit = limitParam ? Number(limitParam) : NaN;
  const limit =
    Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const baseOptions = {
    query,
    types,
    format,
    status,
    statusMode,
    browseAll: true,
    sortBy,
    ...(activeLetter ? { startsWith: { letter: activeLetter, field: letterField } } : {}),
  };

  // Fetch one extra row to detect whether more results exist beyond this
  // page, without a second count query.
  const fetched = await searchCatalog({ ...baseOptions, limit: limit + 1 });
  const hasMore = fetched.length > limit;
  const results = hasMore ? fetched.slice(0, limit) : fetched;
  // At the ceiling the next step would clamp straight back to it, so the link
  // would render but do nothing. Show the narrow-down hint instead of a
  // button that silently no-ops.
  const atMaxPageSize = limit >= MAX_PAGE_SIZE;
  const canLoadMore = hasMore && !atMaxPageSize;

  const totalCount = await countCatalog(baseOptions);

  // The nav must list every available letter, not collapse to just the
  // currently-selected one -- so this deliberately queries WITHOUT the
  // startsWith filter, even when one is active.
  const availableLetters = supportsLetterJump
    ? await getAvailableStartsWithLetters(
        { query, types, format, status, statusMode, browseAll: true, sortBy },
        letterField,
      )
    : [];

  // Shared by "Load more" and the jump-to-letter links -- every param
  // EXCEPT limit/startsWith, which each caller sets for itself.
  function buildBaseParams(): URLSearchParams {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (types) params.set("types", types.join(","));
    if (format) params.set("format", format);
    if (status) params.set("status", status.join(","));
    if (statusMode !== "or") params.set("statusMode", statusMode);
    if (sortBy !== "title") params.set("sort", sortBy);
    return params;
  }

  const loadMoreParams = buildBaseParams();
  if (activeLetter) loadMoreParams.set("startsWith", activeLetter);
  loadMoreParams.set("limit", String(Math.min(limit + DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)));

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

      <div className="mb-4 flex flex-wrap gap-4 text-sm">
        <Link href="/" className="text-link underline">
          Back to search
        </Link>
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
        <label className="flex items-center gap-1 text-sm text-foreground/70">
          Sort
          <select
            name="sort"
            defaultValue={sortBy}
            className="rounded-lg border border-perforation bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <CatalogFilters
          types={types}
          status={status}
          statusMode={statusMode}
          format={format}
          defaultOpen={hasActiveFilters}
        />
        <Button type="submit">Search</Button>
      </form>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/70">
        <p>
          {results.length === totalCount
            ? `${totalCount} book${totalCount === 1 ? "" : "s"}`
            : `Showing ${results.length} of ${totalCount} book${totalCount === 1 ? "" : "s"}`}
        </p>
        <form action={setDensity.bind(null, "books", density === "compact" ? "comfortable" : "compact")}>
          <button type="submit" className="text-link underline">
            {density === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
          </button>
        </form>
      </div>

      {supportsLetterJump && availableLetters.length > 0 && (
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Jump to letter">
          {availableLetters.map((letter) => {
            const params = buildBaseParams();
            params.set("startsWith", letter);
            const isActive = letter === activeLetter;
            return (
              <Link
                key={letter}
                href={`/books?${params.toString()}`}
                className={
                  isActive ? "font-semibold text-foreground-strong underline" : "text-link underline"
                }
              >
                {letter}
              </Link>
            );
          })}
          {activeLetter && (
            <Link href={`/books?${buildBaseParams().toString()}`} className="text-foreground/70 underline">
              Clear
            </Link>
          )}
        </nav>
      )}

      {results.length === 0 ? (
        <p className="text-foreground/70">No books found.</p>
      ) : (
        <>
          <ul className={density === "compact" ? "space-y-1" : "space-y-3"}>
            {results.map((result) => (
              <CatalogResultCard key={result.bookId ?? result.title} result={result} density={density} />
            ))}
          </ul>

          {canLoadMore && (
            <div className="mt-4 text-center">
              <Link
                href={`/books?${loadMoreParams.toString()}`}
                className={`inline-block rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
              >
                Load more
              </Link>
            </div>
          )}

          {hasMore && atMaxPageSize && (
            <p className="mt-4 text-center text-sm text-foreground/70">
              Showing the first {MAX_PAGE_SIZE} books. Search or use the filters above to narrow
              things down.
            </p>
          )}
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors in this file. (`src/app/page.tsx` still has an error until Task 13 — expected mid-plan.)

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites (no lib logic changed in this task, only page wiring).

- [ ] **Step 4: Commit**

```bash
git add src/app/books/page.tsx
git commit -m "feat: wire sort, result count, jump-to-letter, and density into /books"
```

---

### Task 13: Wire `/app/page.tsx` (home) — density toggle and collapsible filters

Home page gets only the density toggle and filter-chrome collapse — sort, result count, and jump-to-letter are `/books`-only per the design spec (home answers "do I already own this?", a few-results confirmation view, not a browse view).

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Replace `src/app/page.tsx`**

Replace the full file:

```tsx
import Link from "next/link";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
} from "@/lib/search";
import { getDensity } from "@/lib/density";
import { setDensity } from "@/lib/actions/density";
import { RefreshSyncButton } from "@/components/RefreshSyncButton";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { CatalogFilters } from "@/components/CatalogFilters";
import { Button } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

export default async function HomePage({
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

  const density = await getDensity("home");
  const results = await searchCatalog({ query, types, format, status, statusMode });
  const hasActiveFilters = Boolean(query || types || format || status);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">Book Catalog</h1>
        <RefreshSyncButton />
      </div>

      <form action="/" method="get" className="mb-4 space-y-2">
        <SearchAutocomplete
          scope="home"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
        />
        <CatalogFilters
          types={types}
          status={status}
          statusMode={statusMode}
          format={format}
          defaultOpen={hasActiveFilters}
        />
        <Button type="submit">Search</Button>
      </form>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex gap-4">
          <Link href="/books" className="text-link underline">
            Manage all books
          </Link>
          <Link href="/tbr" className="text-link underline">
            TBR gap view
          </Link>
          <Link href="/stats" className="text-link underline">
            Library stats
          </Link>
        </div>
        <form action={setDensity.bind(null, "home", density === "compact" ? "comfortable" : "compact")}>
          <button type="submit" className="text-link underline">
            {density === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
          </button>
        </form>
      </div>

      {hasActiveFilters && results.length === 0 && (
        <p className="text-foreground/70">No matches found.</p>
      )}

      {results.length > 0 && (
        <ul className={density === "compact" ? "space-y-1" : "space-y-3"}>
          {results.map((result) => (
            <CatalogResultCard key={result.bookId ?? result.title} result={result} density={density} />
          ))}
        </ul>
      )}

      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm text-link underline">
          Log out
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: zero errors anywhere (this was the last file with an outstanding error from Task 11).

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: wire density toggle and collapsible filters into home page"
```

---

### Task 14: Real-browser verification

Per the spec's own Testing section: "Browser verification at realistic scale, both densities, light and dark, desktop and 390px." This is a manual verification pass, not an automated test — matches this project's existing convention (e.g. PR #32's deep-linking verification, PR #37's series-tracking verification).

**Files:** none (verification only — fix forward in the files above if something's wrong, don't add new files for this task).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (in the background — this connects to the real dev database per `.env`, NOT `.env.test`)

- [ ] **Step 2: Confirm realistic data scale**

If this worktree's dev database already has real book data (per project memory, the user's real library is ~2000 books), no seeding is needed — browse `/books` directly. If the dev database is empty (a fresh worktree/environment), seed a representative throwaway fixture first: at least 60 books spanning several first letters (both title and author), a mix of formats/read statuses/ratings, and at least one book with no author and one with no rating, so every null-handling rule (Task 3) and jump-to-letter bucket (Task 5) has real data to exercise. Delete the fixture afterward if it was throwaway.

- [ ] **Step 3: Load `mcp__plugin_playwright_playwright__*` tools if not already loaded**

Load via `ToolSearch` with query `select:mcp__plugin_playwright_playwright__browser_navigate,mcp__plugin_playwright_playwright__browser_resize,mcp__plugin_playwright_playwright__browser_snapshot,mcp__plugin_playwright_playwright__browser_take_screenshot,mcp__plugin_playwright_playwright__browser_evaluate,mcp__plugin_playwright_playwright__browser_click`.

- [ ] **Step 4: Verify compact density row pitch and count**

Navigate to `http://localhost:3000/books`. Confirm density defaults to compact (no cookie yet). Resize to 1280×900. Use `browser_evaluate` to measure the pitch between two consecutive `[data-testid="catalog-row"]` elements (difference in `getBoundingClientRect().top`). Expect roughly 102px, not the old 280px. Confirm materially more than 3 books are visible above the fold without scrolling.

- [ ] **Step 5: Verify the whole row navigates**

Click anywhere on a compact row that is NOT the cover or title text specifically (e.g. the empty space to the right of the author line). Confirm navigation to `/books/[id]`. Go back.

- [ ] **Step 6: Verify long-title truncation**

Find or temporarily note a book with a long title. Confirm it truncates with an ellipsis rather than wrapping to a second line, and that hovering shows the full title via the native `title` attribute tooltip.

- [ ] **Step 7: Verify the density toggle and its persistence**

Click "Switch to comfortable view". Confirm the layout switches to the original large-card design. Reload the page (full navigation, not client refresh). Confirm it's still comfortable (cookie persisted). Switch back to compact.

- [ ] **Step 8: Verify sorting**

Change the Sort control to each of Author A–Z, Recently added, and Rating high→low, submitting each time. Confirm the visible order changes plausibly for each (e.g. Recently added shows the newest book first).

- [ ] **Step 9: Verify the result count**

With no filters active, confirm the count reads "`N` books" (no "Showing"). Apply a narrowing filter (e.g. a status checkbox) and confirm it switches to "Showing `X` of `Y` books" with `X <= Y`.

- [ ] **Step 10: Verify jump-to-letter**

Under Title A–Z sort, confirm a letter strip appears above the results, confirm clicking a letter filters the list to only that letter (spot-check a couple of titles) and highlights the active letter, and confirm "Clear" returns to the unfiltered list. Switch sort to "Recently added" and confirm the letter strip disappears.

- [ ] **Step 11: Verify filter-chrome collapse**

With no filter active, confirm the filter block renders as a single collapsed "Filters" summary line. Expand it, check a status filter, and submit. Confirm the block now renders expanded on the resulting page load (not silently collapsed with an active filter hidden inside).

- [ ] **Step 12: Repeat the density/truncation/navigation checks in dark mode and at 390×844**

Toggle the app's theme (if a toggle exists) or force `prefers-color-scheme: dark`, and resize to 390×844. Re-check: compact row renders correctly (no overlap between cover/text/stamp), whole-row tap target works, truncation still applies.

- [ ] **Step 13: Repeat a quick pass on the home page (`/`)**

Confirm home page defaults to comfortable density, the density toggle works there independently of `/books`' own toggle (switching one must not affect the other), and the filter block collapses/expands the same way.

- [ ] **Step 14: Stop the dev server and clean up any seeded fixture data**

If Step 2 seeded throwaway fixture books, delete them now. Stop the `npm run dev` background process.

- [ ] **Step 15: Report findings**

If everything in Steps 4-13 checks out, report done. If anything is off, fix it in the relevant file from Tasks 9-13 (not a new file), then repeat the affected verification step before proceeding to Task 15.

---

### Task 15: Finish the branch

- [ ] **Step 1: Run the full test suite one last time**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 2: Run the type checker one last time**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Invoke `superpowers:finishing-a-development-branch`**

Follow that skill's standard flow (verify tests → detect environment → present the 4 options → execute the chosen one) rather than pushing or merging unilaterally here.
