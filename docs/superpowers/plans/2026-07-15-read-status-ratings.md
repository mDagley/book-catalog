# Read Status & Ratings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track a Goodreads-sourced (but manually overridable) read status (to-read/reading/read) and 1-5 star rating on every catalog `Book`, surfaced in search/browse and editable on the book detail page.

**Architecture:** `Book` gains 4 new columns. `goodreadsSync.ts`'s existing to-read-shelf sync is extended to also fetch the currently-reading and read shelves and fuzzy-match every shelf item against existing `Book` rows (reusing the same title-matching logic `absSync.ts` already uses, now extracted into a shared helper), writing `readStatus`/`rating` only on fields not manually overridden. `search.ts` gains a `status`/`rating` filter dimension. A new `readingProgress.ts` + server actions handle manual edits from the book detail page.

**Tech Stack:** Next.js 16 App Router, Prisma 7, PostgreSQL, Vitest (against the real dev database, per this project's existing convention).

**Spec:** `docs/superpowers/specs/2026-07-15-read-status-ratings-design.md`

---

## Task 1: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_read_status_and_ratings/migration.sql`

- [ ] **Step 1: Add the `ReadStatus` enum and four fields to `Book`**

Edit `prisma/schema.prisma` so the `Book` model and a new enum read:

```prisma
enum ReadStatus {
  TO_READ
  READING
  READ
}

model Book {
  id        String         @id @default(cuid())
  title     String
  author    String?
  isbn      String?
  createdAt DateTime       @default(now())
  copies    PhysicalCopy[]

  hasEbook            Boolean   @default(false)
  hasAudiobook        Boolean   @default(false)
  absEbookItemIds     String[]  @default([])
  absAudiobookItemIds String[]  @default([])
  lastAbsSyncedAt     DateTime?

  readStatus       ReadStatus?
  readStatusManual Boolean     @default(false)
  rating           Int?
  ratingManual     Boolean     @default(false)
}
```

Only the new enum and the four new fields at the bottom of `Book` are added — every other line is unchanged.

- [ ] **Step 2: Generate and apply the migration without an interactive prompt**

This sandbox's shell has no TTY, so `prisma migrate dev` cannot run (it blocked on a confirmation prompt during the previous phase too). Use the same non-interactive workaround that worked then — diff the schema against the live datasource, write the script into a manually-created migration folder, then apply with `migrate deploy`:

```bash
TS=$(date -u +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_add_read_status_and_ratings"
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "prisma/migrations/${TS}_add_read_status_and_ratings/migration.sql"
cat "prisma/migrations/${TS}_add_read_status_and_ratings/migration.sql"
```

Expected output (column order may vary slightly since Prisma alphabetizes them — the shape, not the exact byte layout, is what matters):

```sql
-- CreateEnum
CREATE TYPE "ReadStatus" AS ENUM ('TO_READ', 'READING', 'READ');

-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "rating" INTEGER,
ADD COLUMN     "ratingManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "readStatus" "ReadStatus",
ADD COLUMN     "readStatusManual" BOOLEAN NOT NULL DEFAULT false;
```

If the generated SQL doesn't match this shape (e.g. it tries to touch `AbsCacheItem`/`MediaType` or any other unrelated object), stop and report — it means the live datasource has drifted from `schema.prisma` in some other way and the diff isn't safe to apply blindly.

Then apply it and regenerate the client:

```bash
npx prisma migrate deploy
npx prisma generate
```

Expected: `migrate deploy` reports 1 migration applied; `prisma migrate status` (run it to confirm) prints "Database schema is up to date!".

- [ ] **Step 3: Verify the client picked up the new fields**

Run: `npx tsc --noEmit`

Expected: no new errors. (There will likely be pre-existing errors from code that hasn't been written yet in later tasks — there should be none related to `prisma/schema.prisma` or the generated client itself at this point, since nothing references the new fields yet.)

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add ReadStatus enum and read-status/rating fields to Book"
```

---

## Task 2: Extract a Shared Fuzzy-Match Helper

`absSync.ts` already has a private `findBestTitleMatch` function that scans a list of books and returns the best fuzzy title match above threshold. `goodreadsSync.ts` (Task 3) needs the exact same behavior. Extract it into `matching.ts` once, generically, rather than writing a second near-identical copy.

**Files:**
- Modify: `src/lib/matching.ts`
- Modify: `src/lib/matching.test.ts`
- Modify: `src/lib/absSync.ts`

- [ ] **Step 1: Write the failing test**

Add to the end of `src/lib/matching.test.ts`:

```typescript
describe("findBestTitleMatch", () => {
  interface Candidate {
    id: string;
    title: string;
  }

  it("returns the candidate whose title best matches, above threshold", () => {
    const candidates: Candidate[] = [
      { id: "1", title: "The Way of Kings" },
      { id: "2", title: "Mistborn" },
    ];

    const match = findBestTitleMatch(candidates, "the way of kings");

    expect(match?.id).toBe("1");
  });

  it("returns null when no candidate is above threshold", () => {
    const candidates: Candidate[] = [{ id: "1", title: "The Way of Kings" }];

    const match = findBestTitleMatch(candidates, "Completely Unrelated Title Zzz");

    expect(match).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(findBestTitleMatch([], "Anything")).toBeNull();
  });

  it("picks the highest-scoring candidate when more than one is above threshold", () => {
    const candidates: Candidate[] = [
      { id: "close", title: "The Way of Kingz" },
      { id: "exact", title: "The Way of Kings" },
    ];

    const match = findBestTitleMatch(candidates, "The Way of Kings");

    expect(match?.id).toBe("exact");
  });

  it("respects a custom threshold argument", () => {
    const candidates: Candidate[] = [{ id: "1", title: "Somewhat Similar Title" }];

    expect(findBestTitleMatch(candidates, "Somewhat Similar Titlee", 99)).toBeNull();
    expect(findBestTitleMatch(candidates, "Somewhat Similar Titlee", 50)).not.toBeNull();
  });
});
```

Add `findBestTitleMatch` to the existing import line at the top of the file:

```typescript
import {
  normalizeTitle,
  stripSeriesSuffix,
  titleForms,
  sequenceMatcherRatio,
  titleMatchScore,
  isTitleMatch,
  findBestTitleMatch,
} from "@/lib/matching";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/matching.test.ts`
Expected: FAIL — `findBestTitleMatch` is not exported yet.

- [ ] **Step 3: Add the shared helper to `matching.ts`**

Add this at the end of `src/lib/matching.ts`:

```typescript
// Scans `candidates` for the best fuzzy title match to `title`, returning
// null if nothing scores at or above `threshold`. Generic over any shape
// that carries a `title` string, so both absSync.ts's Book-shaped rows and
// goodreadsSync.ts's Book-shaped rows can share one implementation instead
// of each maintaining a near-identical private copy.
export function findBestTitleMatch<T extends { title: string }>(
  candidates: T[],
  title: string,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = titleMatchScore(candidate.title, title);
    if (score >= threshold && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/matching.test.ts`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 5: Point `absSync.ts` at the shared helper instead of its own copy**

In `src/lib/absSync.ts`, change the import line:

```typescript
import { findBestTitleMatch } from "@/lib/matching";
```

(This replaces `import { titleMatchScore, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";` — neither of those two is used anywhere else in this file once the local function below is deleted.)

Delete the local function (currently at lines 110-121):

```typescript
function findBestTitleMatch(books: SyncBook[], title: string): SyncBook | null {
  let best: SyncBook | null = null;
  let bestScore = -1;
  for (const book of books) {
    const score = titleMatchScore(book.title, title);
    if (score >= DEFAULT_MATCH_THRESHOLD && score > bestScore) {
      best = book;
      bestScore = score;
    }
  }
  return best;
}
```

Leave every call site (`findBestTitleMatch(books, item.title)`) unchanged — the imported function has the same signature for this call shape.

- [ ] **Step 6: Run the full absSync test suite to confirm nothing broke**

Run: `npx vitest run src/lib/absSync.test.ts`
Expected: PASS, all existing tests (this refactor changes no behavior).

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no new errors.

```bash
git add src/lib/matching.ts src/lib/matching.test.ts src/lib/absSync.ts
git commit -m "refactor: extract shared findBestTitleMatch helper into matching.ts"
```

---

## Task 3: Extend `goodreadsSync.ts` for Currently-Reading/Read Shelves

**Files:**
- Modify: `src/lib/goodreadsSync.ts`
- Modify: `src/lib/goodreadsSync.test.ts`

### Context confirmed during design

A real Goodreads shelf RSS feed (`https://www.goodreads.com/review/list_rss/<id>?shelf=read`) was fetched and inspected directly: each `<item>` includes a `<user_rating>` element, an integer 0-5 where 0 means "not rated" (confirmed against real data: a sample of 50 items came back with a mix of 0/3/4/5). This is the field this task parses — no further verification needed before implementing.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/lib/goodreadsSync.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  fetchGoodreadsPage,
  fetchAllGoodreadsBooks,
  syncGoodreadsTbr,
  type GoodreadsShelf,
} from "@/lib/goodreadsSync";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SAMPLE_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>The Way of Kings</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn>0765326353</isbn>
      <isbn13>9780765326355</isbn13>
      <user_rating>0</user_rating>
    </item>
    <item>
      <title>Mistborn</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn></isbn>
      <isbn13></isbn13>
      <user_rating>4</user_rating>
    </item>
  </channel>
</rss>`;

const EMPTY_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel></channel></rss>`;

const LEADING_ZERO_ISBN_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>The Way of Kings</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn>0765326353</isbn>
      <isbn13></isbn13>
      <user_rating>0</user_rating>
    </item>
  </channel>
</rss>`;

const LOWERCASE_X_ISBN_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Some Book With An X Check Digit</title>
      <author_name>Some Author</author_name>
      <isbn>043965548x</isbn>
      <isbn13></isbn13>
      <user_rating>0</user_rating>
    </item>
  </channel>
</rss>`;

describe("fetchGoodreadsPage", () => {
  it("parses title/author/isbn/rating from an RSS page", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([
      { title: "The Way of Kings", author: "Brandon Sanderson", isbn: "9780765326355", rating: null },
      { title: "Mistborn", author: "Brandon Sanderson", isbn: null, rating: 4 },
    ]);
  });

  it("preserves a leading-zero ISBN-10 as a string when isbn13 is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => LEADING_ZERO_ISBN_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([
      { title: "The Way of Kings", author: "Brandon Sanderson", isbn: "0765326353", rating: null },
    ]);
  });

  it("uppercases a lowercase ISBN-10 check digit, matching Book row normalization", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => LOWERCASE_X_ISBN_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([
      { title: "Some Book With An X Check Digit", author: "Some Author", isbn: "043965548X", rating: null },
    ]);
  });

  it("returns an empty array for a shelf page with no items", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([]);
  });

  it("throws a clear error on a non-XML response instead of a raw parser exception", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html>Rate limited</html>",
    } as Response);

    await expect(fetchGoodreadsPage("1993628", "to-read", 1)).rejects.toThrow(/goodreads/i);
  });

  it("requests the given shelf with the expected query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);
    global.fetch = fetchMock;

    await fetchGoodreadsPage("1993628", "currently-reading", 3);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/review/list_rss/1993628");
    expect(calledUrl.searchParams.get("shelf")).toBe("currently-reading");
    expect(calledUrl.searchParams.get("page")).toBe("3");
  });
});

describe("fetchAllGoodreadsBooks", () => {
  it("paginates until an empty page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_RSS_PAGE } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);
    global.fetch = fetchMock;

    const books = await fetchAllGoodreadsBooks("1993628", "to-read");

    expect(books).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Builds a minimal shelf RSS page from a list of items -- keeps the
// combined-sync tests below (which each need their own distinct fixture
// content per shelf) from repeating large XML string literals.
function buildRssPage(
  items: Array<{ title: string; author?: string; isbn13?: string; rating?: number }>,
): string {
  const itemsXml = items
    .map(
      (i) => `
    <item>
      <title>${i.title}</title>
      <author_name>${i.author ?? ""}</author_name>
      <isbn13>${i.isbn13 ?? ""}</isbn13>
      <user_rating>${i.rating ?? 0}</user_rating>
    </item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>${itemsXml}</channel></rss>`;
}

// Mocks global.fetch to serve different, independently-paginating content per
// shelf, keyed off the real `shelf` query param syncGoodreadsTbr's three
// fetchAllGoodreadsBooks calls each send -- far less fragile than a single
// positional mockResolvedValueOnce chain once three shelves are in flight at
// once. Each shelf not given an explicit page list serves EMPTY_RSS_PAGE
// (and any shelf runs out of configured pages, it also falls back to empty,
// which is exactly what real pagination termination looks like).
function mockShelfFetch(pages: Partial<Record<GoodreadsShelf, string[]>>): void {
  const cursors: Partial<Record<GoodreadsShelf, number>> = {};
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const shelf = url.searchParams.get("shelf") as GoodreadsShelf;
    const shelfPages = pages[shelf];
    const cursor = cursors[shelf] ?? 0;
    cursors[shelf] = cursor + 1;
    const text = shelfPages?.[cursor] ?? EMPTY_RSS_PAGE;
    return { ok: true, text: async () => text } as Response;
  });
}

describe("syncGoodreadsTbr", () => {
  // These tests exercise syncGoodreadsTbr's real full-table-replace
  // (GoodreadsTbrItem) and real Book-matching behavior directly against the
  // real dev Postgres (not a mock) -- see the memory note on this file's
  // history for why GoodreadsTbrItem gets snapshotted/restored. Book rows
  // are NOT snapshotted/restored wholesale (unlike GoodreadsTbrItem) --
  // instead, exactly like absSync.test.ts's own established convention,
  // every Book fixture used here is created with a distinctive
  // "Test Goodreads Sync ..." title prefix that cannot plausibly fuzzy-match
  // any of the user's real book titles, and cleaned up afterward by that
  // prefix. This is deliberately simpler than a full-table Book snapshot,
  // and matches how absSync.test.ts already protects real data.
  let realDataSnapshot: Array<{
    id: string;
    title: string;
    author: string | null;
    isbn: string | null;
    lastSyncedAt: Date;
  }> = [];

  beforeEach(async () => {
    realDataSnapshot = await prisma.goodreadsTbrItem.findMany({
      select: { id: true, title: true, author: true, isbn: true, lastSyncedAt: true },
    });
  });

  afterEach(async () => {
    if (realDataSnapshot.length > 0) {
      await prisma.$transaction([
        prisma.goodreadsTbrItem.deleteMany(),
        prisma.goodreadsTbrItem.createMany({ data: realDataSnapshot }),
      ]);
    } else {
      await prisma.goodreadsTbrItem.deleteMany();
    }
    await prisma.book.deleteMany({ where: { title: { startsWith: "Test Goodreads Sync" } } });
  });

  it("fully replaces GoodreadsTbrItem with the freshly fetched to-read set", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Stale Book No Longer On Shelf", author: "Someone" },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync The Way of Kings", author: "Brandon Sanderson" },
        ]),
      ],
    });

    const result = await syncGoodreadsTbr("1993628");

    expect(result).toEqual({ synced: 1 });

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items.some((i) => i.title === "Stale Book No Longer On Shelf")).toBe(false);
    expect(items.some((i) => i.title === "Test Goodreads Sync The Way of Kings")).toBe(true);
  });

  it("leaves the existing cache untouched if Goodreads is unreachable", async () => {
    await prisma.goodreadsTbrItem.deleteMany();
    await prisma.goodreadsTbrItem.create({ data: { title: "Still Here", author: "Someone" } });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncGoodreadsTbr("1993628")).rejects.toThrow();

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Still Here");
  });

  it("sets readStatus and rating on an existing Book matched from the currently-reading shelf", async () => {
    const book = await prisma.book.create({
      data: { title: "Test Goodreads Sync Currently Reading Book" },
    });

    mockShelfFetch({
      "currently-reading": [
        buildRssPage([{ title: "Test Goodreads Sync Currently Reading Book", rating: 4 }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READING");
    expect(updated.rating).toBe(4);
    expect(updated.readStatusManual).toBe(false);
    expect(updated.ratingManual).toBe(false);
  });

  it("sets READ status when a book appears on the read shelf, overriding an earlier-processed to-read match", async () => {
    const book = await prisma.book.create({
      data: { title: "Test Goodreads Sync Multi Shelf Book" },
    });

    // Same book listed on both shelves in one sync (atypical but possible) --
    // per the design spec, whichever shelf is processed last wins. Shelves
    // are always processed to-read, then currently-reading, then read.
    mockShelfFetch({
      "to-read": [buildRssPage([{ title: "Test Goodreads Sync Multi Shelf Book" }])],
      read: [buildRssPage([{ title: "Test Goodreads Sync Multi Shelf Book", rating: 5 }])],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(5);
  });

  it("does not overwrite a manually-set readStatus, but still syncs rating if rating isn't manual", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Goodreads Sync Manual Status Book",
        readStatus: "READ",
        readStatusManual: true,
      },
    });

    mockShelfFetch({
      "currently-reading": [
        buildRssPage([{ title: "Test Goodreads Sync Manual Status Book", rating: 4 }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(4);
  });

  it("does not overwrite a manually-set rating, but still syncs readStatus if status isn't manual", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Goodreads Sync Manual Rating Book",
        rating: 2,
        ratingManual: true,
      },
    });

    mockShelfFetch({
      read: [buildRssPage([{ title: "Test Goodreads Sync Manual Rating Book", rating: 5 }])],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(2);
  });

  it("does not clear an existing rating when a later-synced shelf item has no rating", async () => {
    const book = await prisma.book.create({
      data: { title: "Test Goodreads Sync Preserve Rating Book", rating: 3 },
    });

    mockShelfFetch({
      read: [buildRssPage([{ title: "Test Goodreads Sync Preserve Rating Book" }])], // rating omitted -> 0 -> null
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(3);
  });

  it("ignores a shelf item with no matching Book -- creates nothing", async () => {
    mockShelfFetch({
      read: [buildRssPage([{ title: "Test Goodreads Sync Unowned Book" }])],
    });

    await syncGoodreadsTbr("1993628");

    const found = await prisma.book.findMany({
      where: { title: "Test Goodreads Sync Unowned Book" },
    });
    expect(found).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`
Expected: FAIL — `fetchGoodreadsPage` still takes 2 args, `GoodreadsShelf` isn't exported, `rating` isn't parsed, and `syncGoodreadsTbr` doesn't touch `Book` at all yet.

- [ ] **Step 3: Rewrite `goodreadsSync.ts`**

Replace the entire contents of `src/lib/goodreadsSync.ts` with:

```typescript
import { XMLParser } from "fast-xml-parser";
import type { ReadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeIsbn as normalizeIsbnShared } from "@/lib/books";
import { findBestTitleMatch } from "@/lib/matching";

export interface GoodreadsBook {
  title: string;
  author: string | null;
  isbn: string | null;
  rating: number | null;
}

export type GoodreadsShelf = "to-read" | "currently-reading" | "read";

const MAX_PAGES = 100; // matches the audiobook-compare reference script's cap

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

function normalizeIsbn(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  const normalized = normalizeIsbnShared(s);
  return normalized || null;
}

// Goodreads' per-shelf RSS feed includes <user_rating>, an integer 0-5 where
// 0 means "not rated" -- confirmed against a real feed during design (see
// docs/superpowers/specs/2026-07-15-read-status-ratings-design.md). Mapped
// to null (not 0) to match Book.rating's own null-means-unrated convention.
function parseRating(raw: unknown): number | null {
  const n = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : 0;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function fetchGoodreadsPage(
  userId: string,
  shelf: GoodreadsShelf,
  page: number,
): Promise<GoodreadsBook[]> {
  const url = new URL(`https://www.goodreads.com/review/list_rss/${userId}`);
  url.searchParams.set("shelf", shelf);
  url.searchParams.set("per_page", "200");
  url.searchParams.set("page", String(page));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Goodreads for shelf "${shelf}" page ${page}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Goodreads shelf "${shelf}" page ${page}: HTTP ${response.status}`,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new Error(
      `Failed to read Goodreads response body for shelf "${shelf}" page ${page}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed;
  try {
    parsed = parser.parse(text);
  } catch {
    throw new Error(
      `Goodreads returned non-XML on shelf "${shelf}" page ${page} (first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  if (parsed?.rss === undefined) {
    throw new Error(
      `Goodreads returned an unexpected response shape on shelf "${shelf}" page ${page} (missing <rss> root; first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  const rawItems = parsed.rss.channel?.item;
  if (!rawItems) return [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const books: GoodreadsBook[] = [];
  for (const item of items) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const author =
      typeof item.author_name === "string" && item.author_name.trim()
        ? item.author_name.trim()
        : null;
    const isbn = normalizeIsbn(item.isbn13) ?? normalizeIsbn(item.isbn);
    const rating = parseRating(item.user_rating);
    books.push({ title, author, isbn, rating });
  }
  return books;
}

export async function fetchAllGoodreadsBooks(
  userId: string,
  shelf: GoodreadsShelf,
): Promise<GoodreadsBook[]> {
  const allBooks: GoodreadsBook[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const books = await fetchGoodreadsPage(userId, shelf, page);
    if (books.length === 0) break;
    allBooks.push(...books);
    if (page === MAX_PAGES) {
      console.warn(
        `Goodreads sync hit the ${MAX_PAGES}-page cap for user ${userId} shelf "${shelf}" with page ${MAX_PAGES} still non-empty — results may be truncated.`,
      );
    }
  }
  return allBooks;
}

// Shelves are processed in this fixed order: to-read, currently-reading,
// read. A book present on more than one shelf in the same sync (atypical on
// Goodreads but possible) ends up with whichever status/rating its
// LAST-processed shelf implies -- read wins over currently-reading, which
// wins over to-read -- per the design spec.
const STATUS_SYNC_SHELVES: GoodreadsShelf[] = ["to-read", "currently-reading", "read"];

const SHELF_READ_STATUS: Record<GoodreadsShelf, ReadStatus> = {
  "to-read": "TO_READ",
  "currently-reading": "READING",
  read: "READ",
};

interface StatusSyncBook {
  id: string;
  title: string;
  readStatus: ReadStatus | null;
  readStatusManual: boolean;
  rating: number | null;
  ratingManual: boolean;
}

const STATUS_SYNC_BOOK_SELECT = {
  id: true,
  title: true,
  readStatus: true,
  readStatusManual: true,
  rating: true,
  ratingManual: true,
} as const;

// Applies one shelf's items onto already-owned Book rows only -- a shelf
// item with no matching Book is ignored; this phase never creates a Book
// from Goodreads shelf data. Each field's manual-override flag is respected
// independently: a manually-set readStatus is left alone even while rating
// still gets synced for that same Book, and vice versa.
async function applyShelfToBooks(
  shelf: GoodreadsShelf,
  items: GoodreadsBook[],
  books: StatusSyncBook[],
): Promise<void> {
  const targetStatus = SHELF_READ_STATUS[shelf];

  for (const item of items) {
    const match = findBestTitleMatch(books, item.title);
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
    books[books.findIndex((b) => b.id === updated.id)] = updated;
  }
}

// Full replace (not upsert-by-id) for GoodreadsTbrItem since Goodreads' RSS
// feed exposes no stable per-item id to key on, and a book removed from the
// to-read shelf should disappear from the TBR gap view too -- per the
// original design spec. The currently-reading/read shelves are additionally
// matched against existing Book rows to set readStatus/rating -- see
// docs/superpowers/specs/2026-07-15-read-status-ratings-design.md.
export async function syncGoodreadsTbr(userId: string): Promise<{ synced: number }> {
  const shelfItems: Record<GoodreadsShelf, GoodreadsBook[]> = {
    "to-read": await fetchAllGoodreadsBooks(userId, "to-read"),
    "currently-reading": await fetchAllGoodreadsBooks(userId, "currently-reading"),
    read: await fetchAllGoodreadsBooks(userId, "read"),
  };

  await prisma.$transaction([
    prisma.goodreadsTbrItem.deleteMany(),
    prisma.goodreadsTbrItem.createMany({
      data: shelfItems["to-read"].map((book) => ({
        title: book.title,
        author: book.author,
        isbn: book.isbn,
      })),
    }),
  ]);

  const books: StatusSyncBook[] = await prisma.book.findMany({ select: STATUS_SYNC_BOOK_SELECT });
  for (const shelf of STATUS_SYNC_SHELVES) {
    await applyShelfToBooks(shelf, shelfItems[shelf], books);
  }

  const synced = STATUS_SYNC_SHELVES.reduce((sum, shelf) => sum + shelfItems[shelf].length, 0);
  return { synced };
}
```

Note: `synced` now counts items across all three shelves (previously just the to-read shelf) — it's purely an informational count used in logs/the refresh-button response, not asserted anywhere beyond the first test above (which only populates the to-read shelf, so its expected count is unaffected in shape, just now explicit about which shelf contributes).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (This will surface any other file still calling `fetchGoodreadsPage`/`fetchAllGoodreadsBooks` with the old 2-arg signature — there shouldn't be any outside this test file, but confirm.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "feat: sync read status and ratings from Goodreads currently-reading/read shelves"
```

---

## Task 4: Manual Edit Layer (`readingProgress.ts`)

**Files:**
- Create: `src/lib/readingProgress.ts`
- Create: `src/lib/readingProgress.test.ts`
- Create: `src/lib/actions/readingProgress.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/readingProgress.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  updateReadStatusData,
  updateRatingData,
  clearReadStatusManualData,
  clearRatingManualData,
} from "@/lib/readingProgress";

afterEach(async () => {
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Reading Progress" } } });
});

async function createTestBook(
  overrides: Partial<{
    readStatus: "TO_READ" | "READING" | "READ" | null;
    readStatusManual: boolean;
    rating: number | null;
    ratingManual: boolean;
  }> = {},
) {
  return prisma.book.create({ data: { title: "Test Reading Progress Book", ...overrides } });
}

describe("updateReadStatusData", () => {
  it("sets readStatus and marks it manual", async () => {
    const book = await createTestBook();

    const result = await updateReadStatusData(book.id, "READING");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READING");
    expect(updated.readStatusManual).toBe(true);
  });

  it("clears readStatus to null on an empty value, still marking it manual", async () => {
    const book = await createTestBook({ readStatus: "READ", readStatusManual: false });

    const result = await updateReadStatusData(book.id, "");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBeNull();
    expect(updated.readStatusManual).toBe(true);
  });

  it("returns an error for an invalid status value", async () => {
    const book = await createTestBook();

    const result = await updateReadStatusData(book.id, "NOT_A_STATUS");

    expect(result).toEqual({ error: "Invalid read status" });
  });
});

describe("updateRatingData", () => {
  it("sets a rating from 1-5 and marks it manual", async () => {
    const book = await createTestBook();

    const result = await updateRatingData(book.id, "4");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.rating).toBe(4);
    expect(updated.ratingManual).toBe(true);
  });

  it("clears rating to null on an empty value", async () => {
    const book = await createTestBook({ rating: 5, ratingManual: false });

    const result = await updateRatingData(book.id, "");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.rating).toBeNull();
  });

  it("returns an error for a rating outside 1-5", async () => {
    const book = await createTestBook();

    const result = await updateRatingData(book.id, "6");

    expect(result).toEqual({ error: "Rating must be a whole number from 1 to 5" });
  });

  it("returns an error for a non-numeric rating", async () => {
    const book = await createTestBook();

    const result = await updateRatingData(book.id, "abc");

    expect(result).toEqual({ error: "Rating must be a whole number from 1 to 5" });
  });
});

describe("clearReadStatusManualData", () => {
  it("clears the manual flag without changing the status value", async () => {
    const book = await createTestBook({ readStatus: "READ", readStatusManual: true });

    await clearReadStatusManualData(book.id);

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.readStatusManual).toBe(false);
  });
});

describe("clearRatingManualData", () => {
  it("clears the manual flag without changing the rating value", async () => {
    const book = await createTestBook({ rating: 3, ratingManual: true });

    await clearRatingManualData(book.id);

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.rating).toBe(3);
    expect(updated.ratingManual).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/readingProgress.test.ts`
Expected: FAIL — `src/lib/readingProgress.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/lib/readingProgress.ts`**

```typescript
import { prisma } from "@/lib/prisma";
import type { ReadStatus } from "@prisma/client";

export const READ_STATUS_VALUES = ["TO_READ", "READING", "READ"] as const satisfies readonly ReadStatus[];

function parseReadStatusInput(raw: string): { value: ReadStatus | null } | { error: string } {
  if (raw === "") return { value: null };
  if ((READ_STATUS_VALUES as readonly string[]).includes(raw)) {
    return { value: raw as ReadStatus };
  }
  return { error: "Invalid read status" };
}

function parseRatingInput(raw: string): { value: number | null } | { error: string } {
  if (raw === "") return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return { error: "Rating must be a whole number from 1 to 5" };
  }
  return { value: n };
}

export async function updateReadStatusData(
  bookId: string,
  rawStatus: string,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseReadStatusInput(rawStatus);
  if ("error" in parsed) return parsed;

  await prisma.book.update({
    where: { id: bookId },
    data: { readStatus: parsed.value, readStatusManual: true },
  });
  return { ok: true };
}

export async function updateRatingData(
  bookId: string,
  rawRating: string,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseRatingInput(rawRating);
  if ("error" in parsed) return parsed;

  await prisma.book.update({
    where: { id: bookId },
    data: { rating: parsed.value, ratingManual: true },
  });
  return { ok: true };
}

export async function clearReadStatusManualData(bookId: string): Promise<void> {
  await prisma.book.update({ where: { id: bookId }, data: { readStatusManual: false } });
}

export async function clearRatingManualData(bookId: string): Promise<void> {
  await prisma.book.update({ where: { id: bookId }, data: { ratingManual: false } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/readingProgress.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Add the server action wrappers**

Create `src/lib/actions/readingProgress.ts`:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import {
  updateReadStatusData,
  updateRatingData,
  clearReadStatusManualData,
  clearRatingManualData,
} from "@/lib/readingProgress";

export async function updateReadStatus(bookId: string, formData: FormData): Promise<void> {
  const result = await updateReadStatusData(bookId, (formData.get("readStatus") as string) ?? "");
  // No client-visible error state for this control -- the <select> only ever
  // submits one of its own valid option values, so an error here can only
  // come from a tampered request, not a normal user interaction.
  if ("error" in result) return;
  revalidatePath(`/books/${bookId}`);
  revalidatePath("/");
}

export async function updateRating(bookId: string, formData: FormData): Promise<void> {
  const result = await updateRatingData(bookId, (formData.get("rating") as string) ?? "");
  if ("error" in result) return;
  revalidatePath(`/books/${bookId}`);
  revalidatePath("/");
}

export async function clearReadStatusManual(bookId: string): Promise<void> {
  await clearReadStatusManualData(bookId);
  revalidatePath(`/books/${bookId}`);
}

export async function clearRatingManual(bookId: string): Promise<void> {
  await clearRatingManualData(bookId);
  revalidatePath(`/books/${bookId}`);
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no new errors.

```bash
git add src/lib/readingProgress.ts src/lib/readingProgress.test.ts src/lib/actions/readingProgress.ts
git commit -m "feat: add manual read-status/rating edit and revert-to-synced actions"
```

---

## Task 5: `search.ts` Status/Rating Filter

**Files:**
- Modify: `src/lib/search.ts`
- Modify: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the end of `src/lib/search.test.ts`, inside the existing `describe("searchCatalog", ...)` block (before its closing `});`):

```typescript
  it("filters to only books with a given read status", async () => {
    await prisma.book.create({
      data: { title: "Test Search Reading Status Book", readStatus: "READING" },
    });
    await prisma.book.create({
      data: { title: "Test Search Read Status Book", readStatus: "READ" },
    });

    const results = await searchCatalog({ status: ["reading"] });

    expect(results.map((r) => r.title)).toContain("Test Search Reading Status Book");
    expect(results.map((r) => r.title)).not.toContain("Test Search Read Status Book");
  });

  it("ORs multiple status values together", async () => {
    await prisma.book.create({
      data: { title: "Test Search To Read Status Book", readStatus: "TO_READ" },
    });
    await prisma.book.create({
      data: { title: "Test Search Read Status Book Two", readStatus: "READ" },
    });
    await prisma.book.create({
      data: { title: "Test Search No Status Book" },
    });

    const results = await searchCatalog({ status: ["to_read", "read"] });

    expect(results.map((r) => r.title)).toEqual(
      expect.arrayContaining([
        "Test Search To Read Status Book",
        "Test Search Read Status Book Two",
      ]),
    );
    expect(results.map((r) => r.title)).not.toContain("Test Search No Status Book");
  });

  it("filters to only unrated books", async () => {
    await prisma.book.create({ data: { title: "Test Search Unrated Book" } });
    await prisma.book.create({ data: { title: "Test Search Rated Book", rating: 3 } });

    const results = await searchCatalog({ status: ["unrated"] });

    expect(results.map((r) => r.title)).toContain("Test Search Unrated Book");
    expect(results.map((r) => r.title)).not.toContain("Test Search Rated Book");
  });

  it("combines a status filter with an existing types filter", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Physical Reading Book",
        readStatus: "READING",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Search Ebook Reading Book",
        readStatus: "READING",
        hasEbook: true,
        absEbookItemIds: ["search-test-status-ebook"],
      },
    });

    const results = await searchCatalog({ types: ["physical"], status: ["reading"] });

    expect(results.map((r) => r.title)).toContain("Test Search Physical Reading Book");
    expect(results.map((r) => r.title)).not.toContain("Test Search Ebook Reading Book");
  });

  it("includes readStatus and rating on every result", async () => {
    await prisma.book.create({
      data: { title: "Test Search Status Display Book", readStatus: "READ", rating: 5 },
    });

    const results = await searchCatalog({ query: "Test Search Status Display Book" });

    expect(results[0].readStatus).toBe("READ");
    expect(results[0].rating).toBe(5);
  });
```

Add to the end of the file, after the existing `describe("parseTypesParam", ...)` block:

```typescript
describe("parseStatusParam", () => {
  it("returns undefined for an undefined or empty value", () => {
    expect(parseStatusParam(undefined)).toBeUndefined();
    expect(parseStatusParam("")).toBeUndefined();
  });

  it("parses a single value", () => {
    expect(parseStatusParam("reading")).toEqual(["reading"]);
  });

  it("parses a comma-separated value", () => {
    expect(parseStatusParam("reading,unrated")).toEqual(["reading", "unrated"]);
  });

  it("parses an array value (repeated same-name checkboxes)", () => {
    expect(parseStatusParam(["to_read", "read"])).toEqual(["to_read", "read"]);
  });

  it("drops unrecognized tokens and keeps valid ones", () => {
    expect(parseStatusParam("reading,bogus,read")).toEqual(["reading", "read"]);
  });

  it("returns undefined when every token is unrecognized", () => {
    expect(parseStatusParam("bogus,alsobogus")).toBeUndefined();
  });
});
```

Update the top import line to pull in the new symbols under test:

```typescript
import { searchCatalog, parseFormatParam, parseTypesParam, parseStatusParam } from "@/lib/search";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/search.test.ts`
Expected: FAIL — `status` isn't a recognized `SearchOptions` field, `parseStatusParam` doesn't exist, and `readStatus`/`rating` aren't on `SearchResult` yet.

- [ ] **Step 3: Update `search.ts`**

Add `ReadStatus` to the type-only import at the top:

```typescript
import type { Format, Prisma, ReadStatus } from "@prisma/client";
```

Add to `SearchResult` (after `hasAudiobook: boolean;`):

```typescript
  readStatus: ReadStatus | null;
  rating: number | null;
```

Add a new exported type and parser, near `OwnershipType`/`parseTypesParam`:

```typescript
export type ReadStatusFilterValue = "to_read" | "reading" | "read" | "unrated";

const VALID_STATUS_VALUES = [
  "to_read",
  "reading",
  "read",
  "unrated",
] as const satisfies readonly ReadStatusFilterValue[];

const STATUS_VALUE_TO_ENUM: Record<Exclude<ReadStatusFilterValue, "unrated">, ReadStatus> = {
  to_read: "TO_READ",
  reading: "READING",
  read: "READ",
};

export function parseStatusParam(
  value: string | string[] | undefined,
): ReadStatusFilterValue[] | undefined {
  if (!value) return undefined;
  const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",");
  const parsed = tokens
    .map((t) => t.trim())
    .filter((t): t is ReadStatusFilterValue => (VALID_STATUS_VALUES as readonly string[]).includes(t));
  return parsed.length > 0 ? parsed : undefined;
}
```

Add `status` to `SearchOptions`:

```typescript
export interface SearchOptions {
  query?: string;
  types?: OwnershipType[];
  format?: Format;
  status?: ReadStatusFilterValue[];
}
```

In `searchCatalog`, after the existing `format`/`types` setup near the top of the function, add:

```typescript
  const statusValues = options.status && options.status.length > 0 ? options.status : undefined;
```

After the block that pushes the ownership `OR` filter (the `if (explicitOwnershipFilterActive) { ... }` block) and before the `if (trimmed) { ... }` block, add a second, independent filter dimension — status/rating is unrelated to ownership, so it doesn't interact with `explicitOwnershipFilterActive` at all:

```typescript
  if (statusValues) {
    const statusOr: Prisma.BookWhereInput[] = [];
    for (const value of statusValues) {
      if (value === "unrated") {
        statusOr.push({ rating: null });
      } else {
        statusOr.push({ readStatus: STATUS_VALUE_TO_ENUM[value] });
      }
    }
    filters.push({ OR: statusOr });
  }
```

Finally, add the two new fields to the `books.map(...)` result at the bottom of `searchCatalog`:

```typescript
    readStatus: book.readStatus,
    rating: book.rating,
```

(placed after `hasAudiobook: includeAudiobook ? book.hasAudiobook : false,`, before the closing `}));`)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/search.test.ts`
Expected: PASS, all tests including the new ones.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no new errors.

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add read-status/rating filter to searchCatalog"
```

---

## Task 6: UI — Badges, Filters, and Edit Controls

**Files:**
- Create: `src/components/ReadingProgressFields.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/books/[id]/page.tsx`

- [ ] **Step 1: Add shared labels/options**

Create `src/components/ReadingProgressFields.tsx`:

```typescript
export const READ_STATUS_OPTIONS = [
  { value: "TO_READ", label: "To Read" },
  { value: "READING", label: "Reading" },
  { value: "READ", label: "Read" },
] as const;

export const READ_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  READ_STATUS_OPTIONS.map((opt) => [opt.value, opt.label]),
);

export const STATUS_FILTER_OPTIONS = [
  { value: "to_read", label: "To Read" },
  { value: "reading", label: "Reading" },
  { value: "read", label: "Read" },
  { value: "unrated", label: "Unrated" },
] as const;

export const RATING_OPTIONS = [1, 2, 3, 4, 5] as const;

export function ratingStars(rating: number): string {
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}
```

- [ ] **Step 2: Update the home page — filter checkboxes and result badges**

In `src/app/page.tsx`, update the imports:

```typescript
import Link from "next/link";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  type OwnershipType,
} from "@/lib/search";
import { FORMAT_OPTIONS, FORMAT_LABELS } from "@/components/CopyFormFields";
import {
  READ_STATUS_LABELS,
  STATUS_FILTER_OPTIONS,
  ratingStars,
} from "@/components/ReadingProgressFields";
import { RefreshSyncButton } from "@/components/RefreshSyncButton";
```

Update the page's props/searchParams type and parsing:

```typescript
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
  }>;
}) {
  const { q, types: typesParam, format: formatParam, status: statusParam } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);

  const results = await searchCatalog({ query, types, format, status });
  const hasActiveFilters = Boolean(query || types || format || status);
```

Add a status/unrated checkbox row to the filter form, right after the existing ownership-type checkboxes' closing and before the format `<select>` (inside the same `<div className="flex flex-wrap items-center gap-3 text-sm">`):

```tsx
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
```

Add badges to each result card, right after the existing `hasAudiobook` badge and before the closing `</div>` of that badge row:

```tsx
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
```

- [ ] **Step 3: Add display + edit controls to the book detail page**

Replace the contents of `src/app/books/[id]/page.tsx` with:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deleteCopy } from "@/lib/actions/copies";
import {
  updateReadStatus,
  updateRating,
  clearReadStatusManual,
  clearRatingManual,
} from "@/lib/actions/readingProgress";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_OPTIONS, RATING_OPTIONS } from "@/components/ReadingProgressFields";

export default async function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({
    where: { id },
    include: { copies: { orderBy: { createdAt: "asc" } } },
  });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{book.title}</h1>
          {book.author && <p className="text-gray-600">{book.author}</p>}
          {book.isbn && <p className="text-sm text-gray-500">ISBN: {book.isbn}</p>}
        </div>
        <Link href={`/books/${book.id}/edit`} className="rounded border px-3 py-2 text-sm">
          Edit
        </Link>
      </div>

      <div className="mb-4 space-y-2 rounded border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <form action={updateReadStatus.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="readStatus" className="text-sm font-medium">
              Status
            </label>
            <select
              id="readStatus"
              name="readStatus"
              defaultValue={book.readStatus ?? ""}
              className="rounded border p-1 text-sm"
            >
              <option value="">Not set</option>
              {READ_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded border px-2 py-1 text-sm">
              Save
            </button>
          </form>
          <span className="text-xs text-gray-500">
            {book.readStatusManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.readStatusManual && (
            <form action={clearReadStatusManual.bind(null, book.id)}>
              <button type="submit" className="text-xs underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={updateRating.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="rating" className="text-sm font-medium">
              Rating
            </label>
            <select
              id="rating"
              name="rating"
              defaultValue={book.rating?.toString() ?? ""}
              className="rounded border p-1 text-sm"
            >
              <option value="">Unrated</option>
              {RATING_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "star" : "stars"}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded border px-2 py-1 text-sm">
              Save
            </button>
          </form>
          <span className="text-xs text-gray-500">
            {book.ratingManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.ratingManual && (
            <form action={clearRatingManual.bind(null, book.id)}>
              <button type="submit" className="text-xs underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Copies ({book.copies.length})</h2>
        <Link
          href={`/books/${book.id}/copies/new`}
          className="rounded bg-black px-3 py-2 text-sm text-white"
        >
          + Add a copy
        </Link>
      </div>

      <ul className="space-y-3">
        {book.copies.map((copy) => (
          <li key={copy.id} className="rounded border p-3">
            <p className="font-medium">{FORMAT_LABELS[copy.format]}</p>
            {copy.publisher && <p className="text-sm text-gray-600">{copy.publisher}</p>}
            {copy.publishYear && <p className="text-sm text-gray-600">{copy.publishYear}</p>}
            {copy.specialNotes && <p className="text-sm text-gray-600">{copy.specialNotes}</p>}
            {copy.coverImagePath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                alt="Cover"
                className="mt-2 h-32 w-24 rounded object-cover"
              />
            )}
            <div className="mt-2 flex gap-2">
              <Link
                href={`/books/${book.id}/copies/${copy.id}/edit`}
                className="text-sm underline"
              >
                Edit
              </Link>
              <form action={deleteCopy.bind(null, copy.id)}>
                <button type="submit" className="text-sm text-red-600 underline">
                  Delete
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 5: Manual browser check**

Run: `npm run dev`, then in a browser:
1. Visit `/` — confirm the new status checkboxes render, and a book with a `readStatus`/`rating` (set directly via `npx prisma studio` or a quick script if none exist yet) shows its badge and stars.
2. Check each status/unrated checkbox individually and confirm the result list narrows as expected.
3. Visit a book's detail page (`/books/[id]`) — confirm the status/rating controls render, changing the status `<select>` and clicking Save updates the displayed "Manually set" indicator and persists after a refresh, and "Let Goodreads manage this again" clears it back to "Synced from Goodreads" without changing the visible value.

Stop the dev server once confirmed.

- [ ] **Step 6: Commit**

```bash
git add src/components/ReadingProgressFields.tsx src/app/page.tsx src/app/books/\[id\]/page.tsx
git commit -m "feat: surface read status and ratings in search/browse and the book detail page"
```

---

## Task 7: Final Verification Pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including every file touched above.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: production build succeeds.

- [ ] **Step 5: Note remaining manual step**

Live verification (matching every prior phase's pattern) can't be done from this sandbox: after this branch is deployed, trigger a real sync (cron or "Refresh now") against the real Goodreads account and confirm real currently-reading/read shelf books get matched to the right catalog `Book`, ratings look correct, unmatched/unowned shelf books are not created as new `Book` rows, and the to-read/TBR-gap view is unchanged. Flag this to the user rather than marking it done — it requires the real deployed app and real account data.
