# Cover Thumbnails in Listings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show book cover thumbnails on the home page's unified search, `/books`, and `/tbr` list views — including sourcing covers for TBR items (Open Library) and backfilling missing covers on existing ebook/audiobook copies (Audiobookshelf's own API).

**Architecture:** A shared pure `resolveListingCover` helper picks which cover represents a book row (physical > ebook > audiobook priority), reused by the home page's `searchCatalog` and `/books`' raw query. `syncGoodreadsTbr` is reworked from a destructive delete+recreate into a reconcile-in-place sync (matching by ISBN, falling back to fuzzy title matching) so a fetched TBR cover survives across syncs. Both the TBR cover fetch (Open Library, via already-existing `lookupIsbn`/`saveCoverFromUrl`) and the ABS cover backfill (Audiobookshelf's own authenticated cover endpoint, via a new small fetch-and-save helper) share one convention: a `coverCheckedAt` timestamp marks "already attempted" so a permanently-missing cover is never retried, and both are capped per sync run to avoid a large one-time burst against either external service.

**Tech Stack:** Next.js App Router (Server Components), Prisma, Vitest (real dev Postgres, no mocks for DB — `vi.fn()` mocks only for `global.fetch`, matching this codebase's existing convention).

---

### Task 1: `resolveListingCover` helper

**Files:**
- Create: `src/lib/listingCover.ts`
- Test: `src/lib/listingCover.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/listingCover.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveListingCover } from "@/lib/listingCover";

describe("resolveListingCover", () => {
  it("prefers a physical copy's cover over ebook/audiobook", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: "physical.jpg" }],
      ebookCopies: [{ coverImagePath: "ebook.jpg" }],
      audiobookCopies: [{ coverImagePath: "audiobook.jpg" }],
    });
    expect(result).toBe("physical.jpg");
  });

  it("falls back to an ebook cover when no physical copy has one", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }],
      ebookCopies: [{ coverImagePath: "ebook.jpg" }],
      audiobookCopies: [{ coverImagePath: "audiobook.jpg" }],
    });
    expect(result).toBe("ebook.jpg");
  });

  it("falls back to an audiobook cover when neither physical nor ebook has one", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }],
      ebookCopies: [],
      audiobookCopies: [{ coverImagePath: "audiobook.jpg" }],
    });
    expect(result).toBe("audiobook.jpg");
  });

  it("uses the first physical copy with a cover, not necessarily the first copy overall", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }, { coverImagePath: "second.jpg" }],
      ebookCopies: [],
      audiobookCopies: [],
    });
    expect(result).toBe("second.jpg");
  });

  it("returns null when nothing has a cover", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }],
      ebookCopies: [{ coverImagePath: null }],
      audiobookCopies: [{ coverImagePath: null }],
    });
    expect(result).toBeNull();
  });

  it("returns null for a book with no copies of any type", () => {
    const result = resolveListingCover({ copies: [], ebookCopies: [], audiobookCopies: [] });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- listingCover.test.ts`
Expected: FAIL — `src/lib/listingCover.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/lib/listingCover.ts`:

```ts
interface CoverSource {
  coverImagePath: string | null;
}

export interface CoverableBook {
  copies: CoverSource[];
  ebookCopies: CoverSource[];
  audiobookCopies: CoverSource[];
}

// Picks which cover represents a book row in a listing: physical copies
// first (in array order), then ebook copies, then audiobook copies -- the
// first non-null coverImagePath found wins. Applies regardless of any
// active ownership-type filter on the caller's side; this only answers
// "which cover identifies this book," not "which cover matches the
// currently filtered view."
export function resolveListingCover(book: CoverableBook): string | null {
  for (const list of [book.copies, book.ebookCopies, book.audiobookCopies]) {
    const found = list.find((c) => c.coverImagePath !== null);
    if (found) return found.coverImagePath;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- listingCover.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/listingCover.ts src/lib/listingCover.test.ts
git commit -m "feat: add resolveListingCover helper for book-listing thumbnails"
```

---

### Task 2: Schema migration — cover fields for TBR items and cover-check tracking

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Update the schema**

In `prisma/schema.prisma`, update the `GoodreadsTbrItem` model:

```prisma
model GoodreadsTbrItem {
  id             String    @id @default(cuid())
  title          String
  author         String?
  isbn           String?
  coverImagePath String?
  coverCheckedAt DateTime?
  lastSyncedAt   DateTime  @default(now())
}
```

Update `EbookCopy`:

```prisma
model EbookCopy {
  id             String    @id @default(cuid())
  bookId         String
  book           Book      @relation(fields: [bookId], references: [id])
  absItemId      String    @unique
  coverImagePath String?
  coverCheckedAt DateTime?
  createdAt      DateTime  @default(now())
}
```

Update `AudiobookCopy`:

```prisma
model AudiobookCopy {
  id             String    @id @default(cuid())
  bookId         String
  book           Book      @relation(fields: [bookId], references: [id])
  absItemId      String    @unique
  coverImagePath String?
  coverCheckedAt DateTime?
  createdAt      DateTime  @default(now())
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npx prisma migrate dev --name add_cover_check_tracking`
Expected: a new migration directory under `prisma/migrations/` adding three nullable columns (`GoodreadsTbrItem.coverImagePath`, `GoodreadsTbrItem.coverCheckedAt`, `EbookCopy.coverCheckedAt`, `AudiobookCopy.coverCheckedAt`); Prisma Client regenerates without errors. All columns are nullable, so this is a safe additive migration with no backfill needed.

- [ ] **Step 3: Verify migration status and run the full test suite**

Run: `npx prisma migrate status && npm test && npx tsc --noEmit`
Expected: "Database schema is up to date!", all existing tests still pass (no existing test should reference these new fields yet), no type errors.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add cover fields to GoodreadsTbrItem and coverCheckedAt to Ebook/AudiobookCopy"
```

---

### Task 3: Extend `searchCatalog` with cover data

**Files:**
- Modify: `src/lib/search.ts`
- Test: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/search.test.ts` (add `import { saveCoverImage, deleteCoverImage } from "@/lib/coverStorage";` near the top if not already present, and track saved paths for cleanup the same way `absSync.test.ts`/`copies.test.ts` do):

```ts
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const savedCoverPaths: string[] = [];
```

(place this near the top of the file, alongside the existing `afterEach`)

Extend the existing `afterEach` to also drain `savedCoverPaths`:

```ts
afterEach(async () => {
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Search" } } },
  });
  await prisma.ebookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Search" } } },
  });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Search" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Search" } } });
  for (const p of savedCoverPaths) {
    await deleteCoverImage(p);
  }
  savedCoverPaths.length = 0;
});
```

Add a new test inside `describe("searchCatalog", ...)`:

```ts
it("resolves a physical-copy cover over an ebook cover in results", async () => {
  const physicalCoverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
  savedCoverPaths.push(physicalCoverPath);
  const ebookCoverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
  savedCoverPaths.push(ebookCoverPath);

  await prisma.book.create({
    data: {
      title: "Test Search Cover Priority Book",
      hasEbook: true,
      ebookCopies: {
        create: { absItemId: "search-test-cover-priority-ebook", coverImagePath: ebookCoverPath },
      },
      copies: { create: { format: "PAPERBACK", coverImagePath: physicalCoverPath } },
    },
  });

  const results = await searchCatalog({ query: "Test Search Cover Priority Book" });

  expect(results[0].coverImagePath).toBe(physicalCoverPath);
});

it("returns null coverImagePath when nothing has a cover", async () => {
  await prisma.book.create({
    data: { title: "Test Search No Cover Book", copies: { create: { format: "PAPERBACK" } } },
  });

  const results = await searchCatalog({ query: "Test Search No Cover Book" });

  expect(results[0].coverImagePath).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- search.test.ts`
Expected: FAIL — `SearchResult` has no `coverImagePath` field yet, so `results[0].coverImagePath` is `undefined`, not matching the assertions.

- [ ] **Step 3: Implement**

In `src/lib/search.ts`, add the import:

```ts
import { resolveListingCover } from "@/lib/listingCover";
```

Add `coverImagePath: string | null;` to the `SearchResult` interface:

```ts
export interface SearchResult {
  title: string;
  author: string | null;
  bookId: string;
  physicalCopies: SearchResultCopy[];
  hasEbook: boolean;
  hasAudiobook: boolean;
  readStatus: ReadStatus | null;
  rating: number | null;
  coverImagePath: string | null;
}
```

Update the `prisma.book.findMany` call inside `searchCatalog` to also fetch cover paths for ebook/audiobook copies:

```ts
  const books = await prisma.book.findMany({
    where: { AND: filters },
    include: {
      copies: { where: format ? { format } : undefined },
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy: { id: "asc" },
  });
```

Update the `.map()` at the end of `searchCatalog` to compute `coverImagePath` — add this field to the returned object (after `rating: book.rating,`):

```ts
    coverImagePath: resolveListingCover(book),
```

(`resolveListingCover` is called with `book` directly — `book.copies` is the format-filtered array already fetched above, which is intentional: the design spec calls for ignoring the *ownership-type* filter for cover resolution, but the format filter narrows which physical copy rows exist at all, so there's nothing extra to special-case here.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- search.test.ts`
Expected: PASS, including all pre-existing tests (the new field is additive, so no existing assertion should break — but re-run the full file to confirm no test does an exact-shape `toEqual` that would now fail on the extra field).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: resolve and return a listing cover in searchCatalog results"
```

---

### Task 4: Home page thumbnail rendering

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Update `src/app/page.tsx`**

Inside the `results.map((result) => ( ... ))` block, immediately after the opening `<li key={result.bookId ?? result.title} className="rounded border p-3">` and before the existing `<p className="font-medium">{result.title}</p>`, add:

```tsx
              {result.coverImagePath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/covers/${encodeURIComponent(result.coverImagePath)}`}
                  alt="Cover"
                  className="mb-2 h-32 w-24 rounded object-cover"
                />
              ) : (
                <div
                  className="mb-2 flex h-32 w-24 items-center justify-center rounded bg-gray-100 text-3xl text-gray-400"
                  aria-hidden="true"
                >
                  📖
                </div>
              )}
```

No other changes to this file — the rest of the `<li>` (title, author, badges, "View details" link) stays exactly as it is.

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass (no page-level tests exist for this file), no type errors. Also run `npm run lint` if that script exists.

- [ ] **Step 3: Manual smoke test**

Run `npm run dev`, then in a browser (or via curl, noting there's no plaintext dev password — a `307` to `/login` with no server error is an acceptable fallback verification, matching prior tasks in this codebase's history) visit `http://localhost:3000/` with a query that returns at least one book with a cover and one without. Confirm both the real cover and the placeholder box render at the expected size, above the title.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: show cover thumbnails in home page search results"
```

---

### Task 5: `/books` cover data + thumbnail rendering

**Files:**
- Modify: `src/app/books/page.tsx`

- [ ] **Step 1: Update `src/app/books/page.tsx`**

Add the import:

```ts
import { resolveListingCover } from "@/lib/listingCover";
```

Update the `include` on the `prisma.book.findMany` call to also fetch ebook/audiobook cover paths:

```ts
  const books = await prisma.book.findMany({
    where: { AND: filters },
    include: {
      copies: true,
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy: { title: "asc" },
  });
```

Update the rendering `.map()` to compute and show the cover. Replace:

```tsx
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
```

with:

```tsx
        <ul className="space-y-3">
          {books.map((book) => {
            const coverImagePath = resolveListingCover(book);
            return (
              <li key={book.id} className="rounded border p-3">
                {coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(coverImagePath)}`}
                    alt="Cover"
                    className="mb-2 h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <div
                    className="mb-2 flex h-32 w-24 items-center justify-center rounded bg-gray-100 text-3xl text-gray-400"
                    aria-hidden="true"
                  >
                    📖
                  </div>
                )}
                <Link href={`/books/${book.id}`} className="font-medium hover:underline">
                  {book.title}
                </Link>
                {book.author && <p className="text-sm text-gray-600">{book.author}</p>}
                <p className="text-sm text-gray-500">
                  {book.copies.length} {book.copies.length === 1 ? "copy" : "copies"}
                </p>
              </li>
            );
          })}
        </ul>
```

- [ ] **Step 2: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 3: Manual smoke test**

Same approach as Task 4's Step 3, against `http://localhost:3000/books`.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/page.tsx
git commit -m "feat: show cover thumbnails on /books"
```

---

### Task 6: Rework `syncGoodreadsTbr` to reconcile instead of delete+recreate

**Files:**
- Modify: `src/lib/goodreadsSync.ts`
- Test: `src/lib/goodreadsSync.test.ts`

**Context:** `syncGoodreadsTbr` currently wipes every `GoodreadsTbrItem` row and recreates them from scratch on every sync, in one `$transaction`. This task replaces that with reconciliation — matching incoming shelf items against existing rows (by ISBN first, then fuzzy title match) so `id`/`coverImagePath`/`coverCheckedAt` survive across syncs. This task does NOT add cover-fetching yet (that's Task 7) — it only makes the sync preserve whatever cover data already exists.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/goodreadsSync.test.ts`. First, update the `realDataSnapshot` type and its `select` in the existing `beforeEach`/`afterEach` (inside `describe("syncGoodreadsTbr", ...)`) to include the two new fields, so the real-data snapshot/restore doesn't silently drop them:

```ts
  let realDataSnapshot: Array<{
    id: string;
    title: string;
    author: string | null;
    isbn: string | null;
    coverImagePath: string | null;
    coverCheckedAt: Date | null;
    lastSyncedAt: Date;
  }> = [];

  beforeEach(async () => {
    realDataSnapshot = await prisma.goodreadsTbrItem.findMany({
      select: {
        id: true,
        title: true,
        author: true,
        isbn: true,
        coverImagePath: true,
        coverCheckedAt: true,
        lastSyncedAt: true,
      },
    });
  });
```

Add new tests inside `describe("syncGoodreadsTbr", ...)`:

```ts
  it("preserves an existing item's id and coverImagePath when it's matched by ISBN across a sync", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Old Title",
        author: "Old Author",
        isbn: "9780765326355",
        coverImagePath: "some-cover.jpg",
      },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          {
            title: "Test Goodreads Sync New Title",
            author: "New Author",
            isbn13: "9780765326355",
          },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(existing.id);
    expect(items[0].coverImagePath).toBe("some-cover.jpg");
    expect(items[0].title).toBe("Test Goodreads Sync New Title");
    expect(items[0].author).toBe("New Author");
  });

  it("preserves an existing item's id and coverImagePath when matched by fuzzy title (no ISBN)", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync The Way of Kings",
        author: "Brandon Sanderson",
        coverImagePath: "way-of-kings-cover.jpg",
      },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync The Way of Kings", author: "Brandon Sanderson" },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(existing.id);
    expect(items[0].coverImagePath).toBe("way-of-kings-cover.jpg");
  });

  it("deletes an existing item's cover file when the item is removed from the shelf", async () => {
    const coverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Goodreads Sync Removed Book", coverImagePath: coverPath },
    });

    mockShelfFetch({ "to-read": [] });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items.some((i) => i.title === "Test Goodreads Sync Removed Book")).toBe(false);
    await expect(readFile(path.join(uploadsDir, coverPath))).rejects.toThrow();
  });

  it("creates a fresh row for a shelf item with no matching existing row", async () => {
    mockShelfFetch({
      "to-read": [buildRssPage([{ title: "Test Goodreads Sync Brand New Book" }])],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany({
      where: { title: "Test Goodreads Sync Brand New Book" },
    });
    expect(items).toHaveLength(1);
    expect(items[0].coverImagePath).toBeNull();
    expect(items[0].coverCheckedAt).toBeNull();
  });
```

Add these imports/constants near the top of the file (alongside the existing ones):

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- goodreadsSync.test.ts`
Expected: FAIL — the current delete+recreate logic assigns fresh `id`s and never preserves `coverImagePath`, so the id/cover-preservation assertions fail (the fresh-row and removed-item tests should already pass, since that behavior is unchanged).

- [ ] **Step 3: Implement the reconciliation rewrite**

In `src/lib/goodreadsSync.ts`, add the import:

```ts
import { deleteCoverImage } from "@/lib/coverStorage";
```

Replace the existing comment-plus-function-signature block (the "Full replace (not upsert-by-id)..." comment immediately above `export async function syncGoodreadsTbr`) and the `$transaction` call inside it. First, add this new function above `syncGoodreadsTbr`:

```ts
interface ExistingTbrItem {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  coverImagePath: string | null;
}

// Reconciles the "to-read" shelf against existing GoodreadsTbrItem rows
// instead of the old delete+recreate approach -- a full replace would
// destroy any fetched cover (coverImagePath/coverCheckedAt) every single
// sync cycle, since Goodreads' RSS feed exposes no stable per-item id to
// upsert on directly. Matches by exact ISBN first (O(1) via a Map), falling
// back to fuzzy title matching (findBestTitleMatch, already used elsewhere
// in this codebase for the same "match incoming data to existing rows with
// no shared stable id" problem) for the remaining pool. A shelf item with no
// match gets a fresh row; an existing row matched to nothing on the current
// shelf (removed from Goodreads) gets deleted, with its cover file cleaned
// up first -- same pattern as PR #19's orphaned-cover cleanup.
//
// Runs as sequential individual Prisma calls, not one large transaction --
// deliberately avoiding the kind of long-held-transaction/connection-pool
// risk that caused the PR #17 production incident (Prisma P2028, "Unable to
// start a transaction in the given time").
async function reconcileTbrItems(shelfItems: GoodreadsBook[]): Promise<void> {
  const existing = await prisma.goodreadsTbrItem.findMany({
    select: { id: true, title: true, author: true, isbn: true, coverImagePath: true },
  });

  const existingByIsbn = new Map<string, ExistingTbrItem>();
  const fuzzyPool: ExistingTbrItem[] = [];
  for (const item of existing) {
    if (item.isbn) {
      existingByIsbn.set(item.isbn, item);
    } else {
      fuzzyPool.push(item);
    }
  }

  const matchedIds = new Set<string>();
  const toCreate: { title: string; author: string | null; isbn: string | null }[] = [];

  for (const shelfItem of shelfItems) {
    let matched: ExistingTbrItem | null = null;
    if (shelfItem.isbn && existingByIsbn.has(shelfItem.isbn)) {
      matched = existingByIsbn.get(shelfItem.isbn)!;
    } else {
      const available = fuzzyPool.filter((item) => !matchedIds.has(item.id));
      matched = findBestTitleMatch(available, shelfItem.title);
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
```

Replace the old comment above `syncGoodreadsTbr` (starting with `// Full replace (not upsert-by-id)...`) with:

```ts
// See reconcileTbrItems above for how GoodreadsTbrItem rows are kept in
// sync with the "to-read" shelf. The currently-reading/read shelves are
// additionally matched against existing Book rows to set readStatus/rating
// -- see docs/superpowers/specs/2026-07-15-read-status-ratings-design.md.
```

Inside `syncGoodreadsTbr`, replace the `$transaction` block:

```ts
  await prisma.$transaction(
    [
      prisma.goodreadsTbrItem.deleteMany(),
      prisma.goodreadsTbrItem.createMany({
        data: shelfItems["to-read"].map((book) => ({
          title: book.title,
          author: book.author,
          isbn: book.isbn,
        })),
      }),
    ],
    { maxWait: 10000, timeout: 20000 },
  );
```

with:

```ts
  await reconcileTbrItems(shelfItems["to-read"]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- goodreadsSync.test.ts`
Expected: PASS, all tests including the pre-existing ones (the "fully replaces" test's name is now slightly imprecise but its assertions — stale item gone, new item present — still hold under reconciliation, since an unmatched existing item is still deleted; leave the test as-is, don't rename it as part of this task).

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "refactor: reconcile GoodreadsTbrItem rows instead of delete+recreate, preserving covers"
```

---

### Task 7: Fetch and store TBR covers from Open Library

**Files:**
- Modify: `src/lib/goodreadsSync.ts`
- Test: `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/goodreadsSync.test.ts`. Add this import near the top:

```ts
import { lookupIsbn } from "@/lib/isbnLookup";
```

`lookupIsbn` isn't a `fetch` call directly usable via `mockShelfFetch`'s router, so mock the module itself. Add `vi.mock("@/lib/isbnLookup")` at the top of the file (outside any `describe`, alongside the existing top-level setup) and drive it per-test via `vi.mocked`:

```ts
vi.mock("@/lib/isbnLookup", () => ({ lookupIsbn: vi.fn() }));
```

Then add these tests inside `describe("syncGoodreadsTbr", ...)`:

```ts
  it("fetches and stores a cover for a new TBR item that has an ISBN", async () => {
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780765326355-M.jpg",
    });
    const originalFetchForCover = global.fetch;
    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync Cover Fetch Book", isbn13: "9780765326355" },
        ]),
      ],
    });
    // mockShelfFetch replaces global.fetch for the RSS calls; saveCoverFromUrl
    // also calls global.fetch for the actual image bytes, so wrap the RSS
    // router to additionally serve a fake image response for the cover URL.
    const rssFetch = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("covers.openlibrary.org")) {
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

    await syncGoodreadsTbr("1993628");

    const item = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync Cover Fetch Book" },
    });
    expect(item.coverImagePath).not.toBeNull();
    expect(item.coverCheckedAt).not.toBeNull();
    if (item.coverImagePath) {
      await deleteCoverImage(item.coverImagePath);
    }
    global.fetch = originalFetchForCover;
  });

  it("sets coverCheckedAt without a coverImagePath when Open Library has no cover", async () => {
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
    mockShelfFetch({
      "to-read": [
        buildRssPage([{ title: "Test Goodreads Sync No Cover Available", isbn13: "9780000000001" }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const item = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync No Cover Available" },
    });
    expect(item.coverImagePath).toBeNull();
    expect(item.coverCheckedAt).not.toBeNull();
  });

  it("never re-attempts a cover fetch once coverCheckedAt is set, even with no coverImagePath", async () => {
    await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Already Checked",
        isbn: "9780000000002",
        coverCheckedAt: new Date(),
      },
    });
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780000000002-M.jpg",
    });
    mockShelfFetch({
      "to-read": [
        buildRssPage([{ title: "Test Goodreads Sync Already Checked", isbn13: "9780000000002" }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    expect(lookupIsbn).not.toHaveBeenCalled();
  });

  it("caps the number of cover fetches attempted in a single sync run", async () => {
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `Test Goodreads Sync Cap Book ${i}`,
      isbn13: `978000000${String(i).padStart(4, "0")}`,
    }));
    mockShelfFetch({ "to-read": [buildRssPage(items)] });

    await syncGoodreadsTbr("1993628");

    expect(lookupIsbn).toHaveBeenCalledTimes(25);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- goodreadsSync.test.ts`
Expected: FAIL — no cover-fetch logic exists yet, so `coverImagePath`/`coverCheckedAt` stay null on every new item and `lookupIsbn` is never called.

- [ ] **Step 3: Implement**

In `src/lib/goodreadsSync.ts`, add imports:

```ts
import { lookupIsbn } from "@/lib/isbnLookup";
import { saveCoverFromUrl } from "@/lib/books";
```

Add this constant and function above `syncGoodreadsTbr`:

```ts
const TBR_COVER_FETCH_CAP = 25;

// Fetches an Open Library cover for any TBR item that has an ISBN and has
// never had a cover-fetch attempt (coverCheckedAt null), capped per run so
// the initial backlog (every existing item, on the first sync after this
// shipped) fills in gradually over several cron cycles instead of one long
// burst against Open Library. coverCheckedAt is always set after an
// attempt, whether or not a cover was found -- see reconcileTbrItems's
// sibling concern above for why a permanently-missing cover must never be
// retried.
async function fetchMissingTbrCovers(): Promise<void> {
  const pending = await prisma.goodreadsTbrItem.findMany({
    where: { coverImagePath: null, coverCheckedAt: null, isbn: { not: null } },
    select: { id: true, isbn: true },
    take: TBR_COVER_FETCH_CAP,
  });

  for (const item of pending) {
    const lookup = await lookupIsbn(item.isbn!);
    let coverImagePath: string | undefined;
    if (lookup.coverUrl) {
      const result = await saveCoverFromUrl(lookup.coverUrl);
      if (!("error" in result)) {
        coverImagePath = result.coverImagePath;
      }
    }
    await prisma.goodreadsTbrItem.update({
      where: { id: item.id },
      data: { coverCheckedAt: new Date(), ...(coverImagePath ? { coverImagePath } : {}) },
    });
  }
}
```

At the end of `syncGoodreadsTbr`, right before the final `return { synced };`, add:

```ts
  await fetchMissingTbrCovers();

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- goodreadsSync.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "feat: fetch and store TBR item covers from Open Library, capped per sync run"
```

---

### Task 8: Backfill covers for existing ebook/audiobook copies from Audiobookshelf

**Files:**
- Modify: `src/lib/absSync.ts`
- Test: `src/lib/absSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/absSync.test.ts`, inside (or near) `describe("syncAbsCache", ...)` — check the existing fetch-routing pattern in this file first (it may already route by URL path for `/api/libraries` vs `/api/libraries/:id/items`; extend that router to also serve `/api/items/:id/cover`, or add a dedicated small router for these new tests if the existing one doesn't already generalize cleanly). `absItemId` is `@unique` on both `EbookCopy` and `AudiobookCopy`, so querying by it directly (no compound key needed) is enough to find the row a test just touched:

```ts
  it("backfills a cover for an existing EbookCopy missing one", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Backfill Ebook",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "backfill-ebook-1" } },
      },
    });

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/libraries")) {
        return { ok: true, json: async () => ({ libraries: [] }) } as Response;
      }
      if (url.includes("/api/items/backfill-ebook-1/cover")) {
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

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.ebookCopy.findFirstOrThrow({
      where: { absItemId: "backfill-ebook-1" },
    });
    expect(updated.coverImagePath).not.toBeNull();
    expect(updated.coverCheckedAt).not.toBeNull();
    if (updated.coverImagePath) {
      savedCoverPaths.push(updated.coverImagePath);
    }
  });

  it("sets coverCheckedAt without a coverImagePath when the ABS cover endpoint returns a non-OK response", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync No Cover Available",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "backfill-audiobook-404" } },
      },
    });

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/libraries")) {
        return { ok: true, json: async () => ({ libraries: [] }) } as Response;
      }
      if (url.includes("/api/items/backfill-audiobook-404/cover")) {
        return { ok: false, status: 404 } as Response;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof global.fetch;

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.audiobookCopy.findFirstOrThrow({
      where: { absItemId: "backfill-audiobook-404" },
    });
    expect(updated.coverImagePath).toBeNull();
    expect(updated.coverCheckedAt).not.toBeNull();
  });

  it("never re-attempts a cover fetch once coverCheckedAt is set", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Already Checked",
        hasEbook: true,
        ebookCopies: {
          create: { absItemId: "backfill-already-checked", coverCheckedAt: new Date() },
        },
      },
    });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/libraries")) {
        return { ok: true, json: async () => ({ libraries: [] }) } as Response;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    global.fetch = fetchMock as typeof global.fetch;

    await syncAbsCache("https://abs.example.com", "token");

    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("backfill-already-checked/cover"),
      expect.anything(),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- absSync.test.ts`
Expected: FAIL — no backfill logic exists yet.

- [ ] **Step 3: Implement**

In `src/lib/absSync.ts`, update the import from `@/lib/coverStorage` to also bring in `saveCoverImage`:

```ts
import { deleteCoverImage, saveCoverImage } from "@/lib/coverStorage";
```

Add this constant and these two functions above `syncAbsCache`:

```ts
const ABS_COVER_FETCH_CAP = 25;

// Fetches a cover directly from Audiobookshelf's own REST API, using the
// same trusted, already-authenticated connection this file uses for
// everything else -- deliberately NOT saveCoverFromUrl's public-URL path,
// which is SSRF-hardened against arbitrary user-supplied hosts (allowlisted
// to covers.openlibrary.org/archive.org only) and would reject a
// self-hosted ABS server outright. absItemId always comes from our own DB
// (never user input), and baseUrl/token are admin-configured env vars, so
// that allowlist doesn't apply to this call site.
async function fetchAbsCoverAndSave(
  baseUrl: string,
  token: string,
  absItemId: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${baseUrl}/api/items/${absItemId}/cover`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const rawContentType = response.headers.get("content-type") ?? "image/jpeg";
    const contentType = rawContentType.split(";")[0].trim();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    return await saveCoverImage(`data:${contentType};base64,${base64}`);
  } catch {
    return null;
  }
}

// Backfills a cover for any EbookCopy/AudiobookCopy that has never had a
// cover-fetch attempt (coverCheckedAt null) and doesn't already have one --
// capped per run, same rationale as fetchMissingTbrCovers in
// goodreadsSync.ts: the first sync after this shipped has every existing
// copy missing both fields, so fetching all of them in one run would be a
// long-running burst against the ABS server. coverCheckedAt is always set
// after an attempt, success or not, so a permanently-missing cover is never
// retried.
async function backfillAbsCovers(baseUrl: string, token: string): Promise<void> {
  const [missingEbookCovers, missingAudiobookCovers] = await Promise.all([
    prisma.ebookCopy.findMany({
      where: { coverImagePath: null, coverCheckedAt: null },
      select: { id: true, absItemId: true },
    }),
    prisma.audiobookCopy.findMany({
      where: { coverImagePath: null, coverCheckedAt: null },
      select: { id: true, absItemId: true },
    }),
  ]);

  const pending = [
    ...missingEbookCovers.map((c) => ({ table: "ebook" as const, id: c.id, absItemId: c.absItemId })),
    ...missingAudiobookCovers.map((c) => ({
      table: "audiobook" as const,
      id: c.id,
      absItemId: c.absItemId,
    })),
  ].slice(0, ABS_COVER_FETCH_CAP);

  for (const copy of pending) {
    const coverImagePath = await fetchAbsCoverAndSave(baseUrl, token, copy.absItemId);
    const data = { coverCheckedAt: new Date(), ...(coverImagePath ? { coverImagePath } : {}) };
    if (copy.table === "ebook") {
      await prisma.ebookCopy.update({ where: { id: copy.id }, data });
    } else {
      await prisma.audiobookCopy.update({ where: { id: copy.id }, data });
    }
  }
}
```

At the end of `syncAbsCache`, right before `return { synced };`, add:

```ts
  await backfillAbsCovers(baseUrl, token);

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- absSync.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/absSync.ts src/lib/absSync.test.ts
git commit -m "feat: backfill covers for existing ebook/audiobook copies from Audiobookshelf"
```

---

### Task 9: `/tbr` thumbnail rendering

**Files:**
- Modify: `src/app/tbr/page.tsx`

- [ ] **Step 1: Update `src/app/tbr/page.tsx`**

Inside the `group.items.map((item) => ( ... ))` block, replace:

```tsx
                <li key={item.id} className="rounded border p-3">
                  <p className="font-medium">{item.title}</p>
                  {item.author && <p className="text-sm text-gray-600">{item.author}</p>}
                </li>
```

with:

```tsx
                <li key={item.id} className="rounded border p-3">
                  {item.coverImagePath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/covers/${encodeURIComponent(item.coverImagePath)}`}
                      alt="Cover"
                      className="mb-2 h-32 w-24 rounded object-cover"
                    />
                  ) : (
                    <div
                      className="mb-2 flex h-32 w-24 items-center justify-center rounded bg-gray-100 text-3xl text-gray-400"
                      aria-hidden="true"
                    >
                      📖
                    </div>
                  )}
                  <p className="font-medium">{item.title}</p>
                  {item.author && <p className="text-sm text-gray-600">{item.author}</p>}
                </li>
```

`TbrGapItem` (from `src/lib/tbrGap.ts`) needs `coverImagePath` added so this compiles — but that field doesn't exist on `TbrGapItem` yet, since `computeTbrGap`'s `select`/`.map()` doesn't fetch it. Update `src/lib/tbrGap.ts`:

In the `TbrGapItem` interface, add:

```ts
export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
  coverImagePath: string | null;
}
```

In `computeTbrGap`, update the `prisma.goodreadsTbrItem.findMany` select and the subsequent `.map()`:

```ts
    prisma.goodreadsTbrItem.findMany({
      select: { id: true, title: true, author: true, coverImagePath: true },
    }),
```

```ts
    .map((tbr) => ({ id: tbr.id, title: tbr.title, author: tbr.author, coverImagePath: tbr.coverImagePath }))
```

- [ ] **Step 2: Update `src/lib/tbrGap.test.ts`**

The `item()` test helper inside `describe("groupByInitial", ...)` builds `TbrGapItem` fixtures directly and will fail to compile once `coverImagePath` becomes required. Update it:

```ts
  function item(title: string, author: string | null): TbrGapItem {
    return { id: title, title, author, coverImagePath: null };
  }
```

- [ ] **Step 3: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 4: Manual smoke test**

Run `npm run dev`, visit `http://localhost:3000/tbr` (or verify no server error via the same curl/307-redirect fallback used in prior tasks). Once Tasks 6-8 have had a chance to run a real sync against your actual Goodreads/ABS data, confirm covers appear for items that have one and the placeholder renders for items that don't.

- [ ] **Step 5: Commit**

```bash
git add src/app/tbr/page.tsx src/lib/tbrGap.ts src/lib/tbrGap.test.ts
git commit -m "feat: show cover thumbnails on /tbr"
```

---

**Self-review notes (spec coverage check):**
- Spec Section 1 (cover resolution data layer) → Tasks 1, 3, 5. ✅
- Spec Section 2 (TBR sync rework + cover fetching) → Tasks 6, 7. ✅
- Spec Section 3 (ABS cover backfill) → Task 8, with a corrected implementation detail: `saveCoverFromUrl` cannot be reused for the ABS endpoint since its SSRF allowlist only permits `covers.openlibrary.org`/`archive.org` — a dedicated `fetchAbsCoverAndSave` bypasses that gate for this trusted, admin-configured, already-authenticated connection instead. ✅
- Spec Section 4 (`coverCheckedAt` retry-storm prevention) → the schema migration (Task 2) plus the cap/never-retry logic built into Tasks 7 and 8. ✅
- Spec Section 5 (UI rendering + placeholder) → Tasks 4, 5, 9. ✅
- Spec's testing section → covered per-task above; no page-level tests, consistent with existing convention. ✅
- Spec's non-goals → nothing in this plan violates them (no lazy-loading/pagination changes, no server-side image resizing beyond CSS crop, no scan-flow changes, no manual re-check UI, no change to the PR #18 upload/edit flow for new copies).
