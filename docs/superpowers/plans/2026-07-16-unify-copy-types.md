# Unify Copy Types (EbookCopy/AudiobookCopy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Book.absEbookItemIds`/`Book.absAudiobookItemIds` (string arrays) with real `EbookCopy`/`AudiobookCopy` tables, mirroring `PhysicalCopy`, so a later phase can attach a cover image to an individual ebook/audiobook item. No user-visible behavior changes in this phase.

**Architecture:** Two new tables + a migration that backfills existing array data into real rows atomically, then `absSync.ts` and `duplicates.ts`'s `mergeBooksData` are rewritten to create/delete/reassign rows instead of pushing/filtering/unioning array entries.

**Tech Stack:** Next.js 16 App Router, Prisma 7, PostgreSQL, Vitest (against the real dev database, per this project's convention).

**Spec:** `docs/superpowers/specs/2026-07-16-unify-copy-types-design.md`

---

## Task 1: Schema Migration (New Tables + Backfill + Column Drop)

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_unify_copy_types/migration.sql`

- [ ] **Step 1: Update the schema**

In `prisma/schema.prisma`, change the `Book` model's ebook/audiobook fields and add the two new models. The full `Book` model becomes:

```prisma
model Book {
  id        String         @id @default(cuid())
  title     String
  author    String?
  isbn      String?
  createdAt DateTime       @default(now())
  copies    PhysicalCopy[]

  hasEbook        Boolean         @default(false)
  hasAudiobook    Boolean         @default(false)
  lastAbsSyncedAt DateTime?
  ebookCopies     EbookCopy[]
  audiobookCopies AudiobookCopy[]

  readStatus       ReadStatus?
  readStatusManual Boolean     @default(false)
  rating           Int?
  ratingManual     Boolean     @default(false)
}
```

(Removed: `absEbookItemIds String[] @default([])`, `absAudiobookItemIds String[] @default([])`. Added: `ebookCopies EbookCopy[]`, `audiobookCopies AudiobookCopy[]`. Everything else on `Book` is unchanged.)

Add two new models, placed after `PhysicalCopy`/`Format` and before `GoodreadsTbrItem`:

```prisma
model EbookCopy {
  id             String   @id @default(cuid())
  bookId         String
  book           Book     @relation(fields: [bookId], references: [id])
  absItemId      String
  coverImagePath String?
  createdAt      DateTime @default(now())
}

model AudiobookCopy {
  id             String   @id @default(cuid())
  bookId         String
  book           Book     @relation(fields: [bookId], references: [id])
  absItemId      String
  coverImagePath String?
  createdAt      DateTime @default(now())
}
```

- [ ] **Step 2: Generate the schema-only diff**

This sandbox's shell has no TTY, so `prisma migrate dev` cannot run interactively — use the same non-interactive workaround used for every prior migration in this project (note: Prisma 7 removed `--from-schema-datasource`; use `--from-config-datasource` instead, confirmed working in this project's most recent migration):

```bash
TS=$(date -u +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_unify_copy_types"
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --script > "prisma/migrations/${TS}_unify_copy_types/migration.sql"
cat "prisma/migrations/${TS}_unify_copy_types/migration.sql"
```

Expected output shape (exact column ordering may vary slightly — Prisma alphabetizes some clauses — the shape is what matters):

```sql
-- CreateTable
CREATE TABLE "EbookCopy" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "absItemId" TEXT NOT NULL,
    "coverImagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbookCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudiobookCopy" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "absItemId" TEXT NOT NULL,
    "coverImagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudiobookCopy_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Book" DROP COLUMN "absAudiobookItemIds",
DROP COLUMN "absEbookItemIds";

-- AddForeignKey
ALTER TABLE "EbookCopy" ADD CONSTRAINT "EbookCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudiobookCopy" ADD CONSTRAINT "AudiobookCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

If the generated SQL touches any table/column not named here (e.g. `PhysicalCopy`, `GoodreadsTbrItem`, `ReadStatus`), stop and report — it means the live datasource has drifted from `schema.prisma` beyond this change, and the diff isn't safe to apply blindly.

- [ ] **Step 2: Insert the data backfill between table creation and column drop**

Edit the generated `migration.sql` to insert a backfill step **between** the two `-- CreateTable` blocks and the `-- AlterTable ... DROP COLUMN` block (i.e., tables must exist before inserting into them, and the array columns must still exist when the backfill reads from them). Insert this section right after the second `CREATE TABLE` statement and before the `-- AlterTable` / `DROP COLUMN` section:

```sql
-- Backfill: convert each existing array entry into a real row before the
-- array columns are dropped below. gen_random_uuid() is used for these
-- rows' ids (not Prisma's application-level cuid()) since a raw SQL
-- migration has no access to Prisma's id generator -- this is safe, since
-- nothing validates the *format* of an existing row's id, only that it's a
-- unique string primary key. Every row the application creates from this
-- point forward still gets a real cuid() via Prisma Client as normal.
INSERT INTO "EbookCopy" ("id", "bookId", "absItemId", "createdAt")
SELECT gen_random_uuid()::text, "Book"."id", "item", COALESCE("Book"."lastAbsSyncedAt", CURRENT_TIMESTAMP)
FROM "Book", unnest("Book"."absEbookItemIds") AS "item";

INSERT INTO "AudiobookCopy" ("id", "bookId", "absItemId", "createdAt")
SELECT gen_random_uuid()::text, "Book"."id", "item", COALESCE("Book"."lastAbsSyncedAt", CURRENT_TIMESTAMP)
FROM "Book", unnest("Book"."absAudiobookItemIds") AS "item";
```

(`unnest()` on an empty array contributes zero rows to the join, so books with no ebook/audiobook links are naturally skipped — no `WHERE array_length(...) > 0` guard needed.)

The final migration file order must be: CreateTable EbookCopy → CreateTable AudiobookCopy → the two backfill INSERTs above → AlterTable (drop columns) → AddForeignKey (both). This ordering matters: the backfill needs the new tables to exist and the old columns to still exist at the same time.

- [ ] **Step 3: Apply and regenerate**

```bash
npx prisma migrate deploy
npx prisma generate
```

Expected: `migrate deploy` reports 1 migration applied; `npx prisma migrate status` prints "Database schema is up to date!".

- [ ] **Step 4: Verify the backfill preserved row counts**

Run this one-off check (adjust nothing — it's read-only) to confirm the backfill didn't lose or duplicate any links. Since the array columns are already dropped by this point, this instead confirms the new tables have a sane total count relative to what's in the dev database now:

```bash
npx prisma studio
```

Or, more directly, from a short Node script using the app's own Prisma client:

```bash
node -e "
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
(async () => {
  const ebookCount = await prisma.ebookCopy.count();
  const audiobookCount = await prisma.audiobookCopy.count();
  const hasEbookCount = await prisma.book.count({ where: { hasEbook: true } });
  const hasAudiobookCount = await prisma.book.count({ where: { hasAudiobook: true } });
  console.log({ ebookCount, audiobookCount, hasEbookCount, hasAudiobookCount });
  await prisma.\$disconnect();
})();
"
```

Expected: `ebookCount`/`audiobookCount` are each greater than or equal to `hasEbookCount`/`hasAudiobookCount` respectively (equal if every owned ebook/audiobook book has exactly one linked item; greater if some books have more than one edition linked, which is expected and fine). If this dev database has no existing ebook/audiobook data yet, all four numbers may be 0 — that's fine too, just confirms the query runs without error.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: pre-existing errors only, from `absSync.ts`/`duplicates.ts` still referencing the now-removed array fields — those are fixed in Tasks 2 and 3. No errors related to `prisma/schema.prisma` or the generated client itself.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add EbookCopy/AudiobookCopy tables, backfill from existing arrays"
```

---

## Task 2: Rewrite `absSync.ts`

**Files:**
- Modify: `src/lib/absSync.ts`
- Modify: `src/lib/absSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `src/lib/absSync.test.ts` with:

```typescript
// src/lib/absSync.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { fetchAbsLibraries, fetchAbsLibraryItems, syncAbsCache } from "@/lib/absSync";
import { searchCatalog } from "@/lib/search";

const originalFetch = global.fetch;

async function cleanupTestAbsSyncBooks(): Promise<void> {
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test Abs Sync" } } } });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Abs Sync" } } },
  });
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Abs Sync" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Abs Sync" } } });
}

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  await cleanupTestAbsSyncBooks();
});

describe("fetchAbsLibraries", () => {
  it("returns id/name pairs for every library", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        libraries: [
          { id: "lib1", name: "Panda EBooks" },
          { id: "lib2", name: "Panda Audiobooks" },
          { id: "lib3", name: "Someone Else's Comics" },
        ],
      }),
    } as Response);

    const libraries = await fetchAbsLibraries("https://abs.example.com", "token");

    expect(libraries).toEqual([
      { id: "lib1", name: "Panda EBooks" },
      { id: "lib2", name: "Panda Audiobooks" },
      { id: "lib3", name: "Someone Else's Comics" },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://abs.example.com/api/libraries",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
  });
});

describe("fetchAbsLibraryItems", () => {
  it("paginates until an empty results page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "item-1",
              media: { metadata: { title: "Book One", authorName: "Author One", isbn: "111" } },
            },
          ],
          total: 2,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "item-2",
              media: { metadata: { title: "Book Two", authorName: "Author Two", isbn: null } },
            },
          ],
          total: 2,
        }),
      } as Response);
    global.fetch = fetchMock;

    const items = await fetchAbsLibraryItems("https://abs.example.com", "token", "lib1");

    expect(items).toEqual([
      { absItemId: "item-1", title: "Book One", author: "Author One", isbn: "111" },
      { absItemId: "item-2", title: "Book Two", author: "Author Two", isbn: null },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when the first page is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], total: 0 }),
    } as Response);

    const items = await fetchAbsLibraryItems("https://abs.example.com", "token", "lib1");

    expect(items).toEqual([]);
  });

  it("normalizes a hyphenated, lowercase-x ISBN the same way Book rows are normalized", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            id: "item-1",
            media: {
              metadata: { title: "Some Book", authorName: "Some Author", isbn: "0-439-65548-x" },
            },
          },
        ],
        total: 1,
      }),
    } as Response);

    const items = await fetchAbsLibraryItems("https://abs.example.com", "token", "lib1");

    expect(items).toEqual([
      { absItemId: "item-1", title: "Some Book", author: "Some Author", isbn: "043965548X" },
    ]);
  });

  it("coerces a numeric ISBN to a string instead of throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            id: "item-1",
            media: {
              metadata: { title: "Some Book", authorName: "Some Author", isbn: 9780765326355 },
            },
          },
        ],
        total: 1,
      }),
    } as Response);

    const items = await fetchAbsLibraryItems("https://abs.example.com", "token", "lib1");

    expect(items).toEqual([
      { absItemId: "item-1", title: "Some Book", author: "Some Author", isbn: "9780765326355" },
    ]);
  });

  it("skips items with a blank or missing title instead of storing an empty string", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { id: "item-blank", media: { metadata: { title: "   ", authorName: "A" } } },
            { id: "item-missing", media: { metadata: { authorName: "B" } } },
            { id: "item-ok", media: { metadata: { title: "Real Title" } } },
          ],
          total: 3,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [] }),
      } as Response);

    const items = await fetchAbsLibraryItems("https://abs.example.com", "token", "lib1");

    expect(items.map((i) => i.absItemId)).toEqual(["item-ok"]);
  });
});

function mockLibrariesAndItems(
  itemsByLibraryId: Record<string, unknown[]>,
  libraries: { id: string; name: string }[],
) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/api/libraries")) {
      return Promise.resolve({ ok: true, json: async () => ({ libraries }) } as Response);
    }
    for (const [libId, results] of Object.entries(itemsByLibraryId)) {
      if (url.includes(libId)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ results, total: results.length }),
        } as Response);
      }
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  });
}

describe("syncAbsCache", () => {
  beforeEach(async () => {
    await cleanupTestAbsSyncBooks();
  });

  it("skips fuzzy matching when the item's ID is already linked (fast path)", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Abs Sync Fast Path Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-fastpath-1" } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-fastpath-1",
            media: { metadata: { title: "Completely Unrelated Title" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 1 });
    const unchanged = await prisma.book.findUniqueOrThrow({
      where: { id: book.id },
      include: { ebookCopies: true },
    });
    expect(unchanged.title).toBe("Test Abs Sync Fast Path Book");
    expect(unchanged.ebookCopies.map((c) => c.absItemId)).toEqual(["test-fastpath-1"]);
    const total = await prisma.book.count({ where: { title: { startsWith: "Test Abs Sync" } } });
    expect(total).toBe(1);
  });

  it("links a first-time fuzzy match into an existing Book without altering its title or author", async () => {
    await prisma.book.create({
      data: { title: "Test Abs Sync Mistborn", author: "Brandon Sanderson" },
    });

    mockLibrariesAndItems(
      {
        "audio-lib": [
          {
            id: "test-fuzzy-1",
            media: { metadata: { title: "Test Abs Sync Mistborn", authorName: "Someone Else" } },
          },
        ],
      },
      [{ id: "audio-lib", name: "Panda Audiobooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const book = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Mistborn" },
      include: { audiobookCopies: true },
    });
    expect(book.author).toBe("Brandon Sanderson");
    expect(book.hasAudiobook).toBe(true);
    expect(book.audiobookCopies.map((c) => c.absItemId)).toEqual(["test-fuzzy-1"]);
    const total = await prisma.book.count({ where: { title: { startsWith: "Test Abs Sync" } } });
    expect(total).toBe(1);
  });

  it("creates a new Book when no existing title matches", async () => {
    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-new-1",
            media: {
              metadata: {
                title: "Test Abs Sync Brand New Book",
                authorName: "New Author",
                isbn: "9780765326355",
              },
            },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const book = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Brand New Book" },
      include: { ebookCopies: true },
    });
    expect(book.hasEbook).toBe(true);
    expect(book.ebookCopies.map((c) => c.absItemId)).toEqual(["test-new-1"]);
    expect(book.author).toBe("New Author");
    expect(book.isbn).toBe("9780765326355");
    const copies = await prisma.physicalCopy.count({ where: { bookId: book.id } });
    expect(copies).toBe(0);
  });

  it("links two different audiobook editions of the same title onto one Book", async () => {
    mockLibrariesAndItems(
      {
        "audio-lib": [
          { id: "test-edition-1", media: { metadata: { title: "Test Abs Sync Two Editions" } } },
          { id: "test-edition-2", media: { metadata: { title: "Test Abs Sync Two Editions" } } },
        ],
      },
      [{ id: "audio-lib", name: "Panda Audiobooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const books = await prisma.book.findMany({
      where: { title: "Test Abs Sync Two Editions" },
      include: { audiobookCopies: true },
    });
    expect(books).toHaveLength(1);
    expect(books[0].audiobookCopies.map((c) => c.absItemId).sort()).toEqual([
      "test-edition-1",
      "test-edition-2",
    ]);
  });

  it("matches a target library by case-insensitive substring, not exact name", async () => {
    mockLibrariesAndItems(
      {
        "ebook-lib": [
          { id: "test-substring-1", media: { metadata: { title: "Test Abs Sync Substring Book" } } },
        ],
        "other-lib": [],
      },
      [
        { id: "ebook-lib", name: "PANDA EBOOKS (Archive)" },
        { id: "other-lib", name: "Someone Else's Comics" },
      ],
    );

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 1 });
    const book = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Substring Book" },
    });
    expect(book.hasEbook).toBe(true);
  });

  it("drops a stale linked ID for one edition while keeping another still-present edition", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Abs Sync Partial Stale Removal",
        hasAudiobook: true,
        audiobookCopies: {
          create: [{ absItemId: "test-partial-keep" }, { absItemId: "test-partial-stale" }],
        },
      },
    });

    mockLibrariesAndItems(
      {
        "audio-lib": [
          {
            id: "test-partial-keep",
            media: { metadata: { title: "Test Abs Sync Partial Stale Removal" } },
          },
        ],
      },
      [{ id: "audio-lib", name: "Panda Audiobooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: book.id },
      include: { audiobookCopies: true },
    });
    expect(updated.audiobookCopies.map((c) => c.absItemId)).toEqual(["test-partial-keep"]);
    expect(updated.hasAudiobook).toBe(true);
  });

  it("deletes a Book that ends up with no ebook, audiobook, or physical copy links", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Fully Removed",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-remove-1" } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-remove-other",
            media: { metadata: { title: "Test Abs Sync Unrelated Survivor" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const remaining = await prisma.book.findMany({
      where: { title: "Test Abs Sync Fully Removed" },
    });
    expect(remaining).toHaveLength(0);
  });

  it("keeps a Book that still has a physical copy even after losing every linked ABS item", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Abs Sync Kept With Physical Copy",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-keep-1" } },
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-keep-other",
            media: { metadata: { title: "Test Abs Sync Unrelated Survivor Two" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: book.id },
      include: { ebookCopies: true },
    });
    expect(updated.hasEbook).toBe(false);
    expect(updated.ebookCopies).toEqual([]);
  });

  it("does not remove any links when a sync fetches zero items across every matching library", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Survives Empty Sync",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-empty-guard-1" } },
      },
    });

    mockLibrariesAndItems({ "ebook-lib": [] }, [{ id: "ebook-lib", name: "Panda EBooks" }]);

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 0 });
    const unchanged = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Survives Empty Sync" },
      include: { ebookCopies: true },
    });
    expect(unchanged.hasEbook).toBe(true);
    expect(unchanged.ebookCopies.map((c) => c.absItemId)).toEqual(["test-empty-guard-1"]);
  });

  it("does not remove any links when no ABS library matches the ebook/audiobook name substrings", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Survives No Matching Library",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-no-library-1" } },
      },
    });

    mockLibrariesAndItems({}, [{ id: "other-lib", name: "Someone Else's Comics" }]);

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 0 });
    const unchanged = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Survives No Matching Library" },
    });
    expect(unchanged.hasAudiobook).toBe(true);
  });

  it("does not remove audiobook links when only the ebook library returns items this pass", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Abs Sync Partial Type Guard",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-partial-type-ebook-1" } },
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-partial-type-audio-stale" } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-partial-type-ebook-1",
            media: { metadata: { title: "Test Abs Sync Partial Type Guard" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: book.id },
      include: { ebookCopies: true, audiobookCopies: true },
    });
    expect(updated.ebookCopies.map((c) => c.absItemId)).toEqual(["test-partial-type-ebook-1"]);
    expect(updated.hasEbook).toBe(true);
    expect(updated.audiobookCopies.map((c) => c.absItemId)).toEqual([
      "test-partial-type-audio-stale",
    ]);
    expect(updated.hasAudiobook).toBe(true);
  });

  it("does not remove ebook links when the audiobook library returns items but the ebook library returns none", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Abs Sync Partial Type Guard Two",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-partial-type-ebook-stale" } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [],
        "audio-lib": [
          {
            id: "test-partial-type-audio-unrelated",
            media: { metadata: { title: "Test Abs Sync Partial Type Guard Two Unrelated Audio" } },
          },
        ],
      },
      [
        { id: "ebook-lib", name: "Panda EBooks" },
        { id: "audio-lib", name: "Panda Audiobooks" },
      ],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: book.id },
      include: { ebookCopies: true },
    });
    expect(updated.ebookCopies.map((c) => c.absItemId)).toEqual(["test-partial-type-ebook-stale"]);
    expect(updated.hasEbook).toBe(true);
  });

  it("throws if the ABS instance is unreachable, without touching existing Book rows", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Still Here",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-unreachable-1" } },
      },
    });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncAbsCache("https://abs.example.com", "token")).rejects.toThrow();

    const stillThere = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Still Here" },
      include: { ebookCopies: true },
    });
    expect(stillThere.ebookCopies.map((c) => c.absItemId)).toEqual(["test-unreachable-1"]);
  });
});

describe("syncAbsCache + searchCatalog integration", () => {
  it("makes a physical book's newly-linked ebook show up in search with both badges", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Integration Physical And Ebook",
        copies: { create: { format: "PAPERBACK" } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-integration-ebook-1",
            media: { metadata: { title: "Test Abs Sync Integration Physical And Ebook" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const results = await searchCatalog({
      query: "Test Abs Sync Integration Physical And Ebook",
    });

    expect(results).toHaveLength(1);
    expect(results[0].physicalCopies).toHaveLength(1);
    expect(results[0].hasEbook).toBe(true);
    expect(results[0].hasAudiobook).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/absSync.test.ts`
Expected: FAIL — the current `absSync.ts` still uses `absEbookItemIds`/`absAudiobookItemIds`, which no longer exist on `Book` after Task 1's migration; Prisma Client errors on every `data`/`select` referencing them.

- [ ] **Step 3: Rewrite `absSync.ts`**

Replace the entire contents of `src/lib/absSync.ts` with:

```typescript
// src/lib/absSync.ts
import { prisma } from "@/lib/prisma";
import { normalizeIsbn } from "@/lib/books";
import { findBestTitleMatch } from "@/lib/matching";

export interface AbsLibrary {
  id: string;
  name: string;
}

export interface AbsBookItem {
  absItemId: string;
  title: string;
  author: string | null;
  isbn: string | null;
}

type AbsMediaType = "EBOOK" | "AUDIOBOOK";

const MAX_PAGES = 500; // 500 * 100 = 50,000 items per library, matching the
// audiobook-compare reference script's own safety cap.
const PAGE_LIMIT = 100;

const LIBRARY_NAME_SUBSTRINGS: [string, AbsMediaType][] = [
  ["panda ebooks", "EBOOK"],
  ["panda audiobooks", "AUDIOBOOK"],
];

// Case-insensitive SUBSTRING match, not exact match — mirrors the reference
// audiobook-compare/list_libraries.py script's own name-filtering behavior,
// so a library named e.g. "Panda EBooks (Archive)" still syncs rather than
// being silently skipped over a naming variation.
function getMediaTypeForLibrary(libraryName: string): AbsMediaType | null {
  const lower = libraryName.toLowerCase();
  for (const [substring, mediaType] of LIBRARY_NAME_SUBSTRINGS) {
    if (lower.includes(substring)) return mediaType;
  }
  return null;
}

export async function fetchAbsLibraries(baseUrl: string, token: string): Promise<AbsLibrary[]> {
  const response = await fetch(`${baseUrl}/api/libraries`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ABS libraries: HTTP ${response.status}`);
  }
  const data = await response.json();
  return (data.libraries ?? []).map((lib: { id: string; name: string }) => ({
    id: lib.id,
    name: lib.name,
  }));
}

export async function fetchAbsLibraryItems(
  baseUrl: string,
  token: string,
  libraryId: string,
): Promise<AbsBookItem[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const allItems: AbsBookItem[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${baseUrl}/api/libraries/${libraryId}/items?limit=${PAGE_LIMIT}&page=${page}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ABS library items (library ${libraryId}, page ${page}): HTTP ${response.status}`,
      );
    }
    const data = await response.json();
    const results = data.results ?? [];
    if (results.length === 0) break;

    for (const item of results) {
      const metadata = item.media?.metadata ?? {};
      const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
      if (!title) continue;
      allItems.push({
        absItemId: item.id,
        title,
        author: metadata.authorName ?? null,
        isbn:
          typeof metadata.isbn === "string" || typeof metadata.isbn === "number"
            ? normalizeIsbn(String(metadata.isbn)) || null
            : null,
      });
    }

    if (allItems.length >= (data.total ?? Infinity)) break;
  }

  return allItems;
}

interface SyncBook {
  id: string;
  title: string;
}

const SYNC_BOOK_SELECT = { id: true, title: true } as const;

// Creates one EbookCopy/AudiobookCopy row for this item WITHOUT touching the
// matched book's title/author/isbn -- per the design spec, ABS metadata is
// never written onto an existing Book, both to avoid a differently-formatted
// ABS title overwriting a good existing one, and to limit the damage of a
// false-positive fuzzy match. Title never changes here, so (unlike the old
// array-based version) there's nothing to refresh on the in-memory `books`
// list afterward -- only a newly CREATED book needs to be added to it.
async function linkItemToExistingBook(
  book: SyncBook,
  mediaType: AbsMediaType,
  absItemId: string,
): Promise<void> {
  if (mediaType === "EBOOK") {
    await prisma.$transaction([
      prisma.ebookCopy.create({ data: { bookId: book.id, absItemId } }),
      prisma.book.update({
        where: { id: book.id },
        data: { hasEbook: true, lastAbsSyncedAt: new Date() },
      }),
    ]);
    return;
  }
  await prisma.$transaction([
    prisma.audiobookCopy.create({ data: { bookId: book.id, absItemId } }),
    prisma.book.update({
      where: { id: book.id },
      data: { hasAudiobook: true, lastAbsSyncedAt: new Date() },
    }),
  ]);
}

async function createBookForItem(item: AbsBookItem, mediaType: AbsMediaType): Promise<SyncBook> {
  if (mediaType === "EBOOK") {
    return prisma.book.create({
      data: {
        title: item.title,
        author: item.author,
        isbn: item.isbn,
        hasEbook: true,
        lastAbsSyncedAt: new Date(),
        ebookCopies: { create: { absItemId: item.absItemId } },
      },
      select: SYNC_BOOK_SELECT,
    });
  }
  return prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      isbn: item.isbn,
      hasAudiobook: true,
      lastAbsSyncedAt: new Date(),
      audiobookCopies: { create: { absItemId: item.absItemId } },
    },
    select: SYNC_BOOK_SELECT,
  });
}

// Deletes any EbookCopy/AudiobookCopy row whose ABS item ID wasn't seen in
// this sync pass, then recomputes hasEbook/hasAudiobook for every book that
// actually lost a row, deleting the Book entirely if it ends up with no
// ebook copies, no audiobook copies, and no physical copies -- mirroring the
// zero-copy cleanup already established for physical-only books. A book
// that had no rows deleted is never touched at all (no wasted writes),
// naturally preserving the old array-based code's "unchanged: skip"
// optimization.
//
// `syncedMediaTypes` gates pruning PER media type: a media type's rows are
// only ever candidates for deletion if at least one item of that specific
// type was actually fetched this pass. This protects against two failure
// modes with one mechanism -- a library renamed/missing so it no longer
// matches the "panda ebooks"/"panda audiobooks" substrings, AND a
// correctly-matched library that happens to return zero items this pass
// (e.g. a transient ABS hiccup) -- either of which would otherwise look
// identical to "the user deleted every book of that type" and wipe real
// ownership data for a media type that was simply never confirmed this pass.
async function removeStaleAbsLinks(
  seenItemIds: Set<string>,
  syncedMediaTypes: Set<AbsMediaType>,
): Promise<void> {
  const affectedBookIds = new Set<string>();

  if (syncedMediaTypes.has("EBOOK")) {
    const staleEbookCopies = await prisma.ebookCopy.findMany({
      where: { absItemId: { notIn: Array.from(seenItemIds) } },
      select: { id: true, bookId: true },
    });
    if (staleEbookCopies.length > 0) {
      await prisma.ebookCopy.deleteMany({
        where: { id: { in: staleEbookCopies.map((c) => c.id) } },
      });
      for (const c of staleEbookCopies) affectedBookIds.add(c.bookId);
    }
  }

  if (syncedMediaTypes.has("AUDIOBOOK")) {
    const staleAudiobookCopies = await prisma.audiobookCopy.findMany({
      where: { absItemId: { notIn: Array.from(seenItemIds) } },
      select: { id: true, bookId: true },
    });
    if (staleAudiobookCopies.length > 0) {
      await prisma.audiobookCopy.deleteMany({
        where: { id: { in: staleAudiobookCopies.map((c) => c.id) } },
      });
      for (const c of staleAudiobookCopies) affectedBookIds.add(c.bookId);
    }
  }

  for (const bookId of affectedBookIds) {
    const [ebookCount, audiobookCount, physicalCount] = await Promise.all([
      prisma.ebookCopy.count({ where: { bookId } }),
      prisma.audiobookCopy.count({ where: { bookId } }),
      prisma.physicalCopy.count({ where: { bookId } }),
    ]);

    if (ebookCount === 0 && audiobookCount === 0 && physicalCount === 0) {
      await prisma.book.delete({ where: { id: bookId } });
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
}

// Syncs the "Panda EBooks" and "Panda Audiobooks" ABS libraries directly onto
// Book rows (see docs/superpowers/specs/2026-07-14-catalog-data-model-unification-design.md
// and docs/superpowers/specs/2026-07-16-unify-copy-types-design.md).
// All ABS API calls happen before any database write, so a fetch failure
// partway through throws without touching the database at all.
export async function syncAbsCache(baseUrl: string, token: string): Promise<{ synced: number }> {
  const libraries = await fetchAbsLibraries(baseUrl, token);

  const relevantLibraries = libraries
    .map((lib) => ({ lib, mediaType: getMediaTypeForLibrary(lib.name) }))
    .filter(
      (entry): entry is { lib: AbsLibrary; mediaType: AbsMediaType } => entry.mediaType !== null,
    );

  const pendingItems: { item: AbsBookItem; mediaType: AbsMediaType }[] = [];
  for (const { lib, mediaType } of relevantLibraries) {
    const items = await fetchAbsLibraryItems(baseUrl, token, lib.id);
    for (const item of items) {
      pendingItems.push({ item, mediaType });
    }
  }

  // A sync that fetched zero items at all is treated as suspicious rather
  // than "the user deleted their whole ABS ebook/audiobook collection" --
  // running the removal pass here would strip every currently-linked Book
  // and delete every ebook/audiobook-only Book in one shot, which is a much
  // likelier sign of a misconfigured library name or a transient ABS hiccup
  // than a real mass deletion. Skip straight to a no-op instead.
  if (pendingItems.length === 0) {
    return { synced: 0 };
  }

  const books: SyncBook[] = await prisma.book.findMany({ select: SYNC_BOOK_SELECT });

  const [existingEbookCopies, existingAudiobookCopies] = await Promise.all([
    prisma.ebookCopy.findMany({ select: { absItemId: true } }),
    prisma.audiobookCopy.findMany({ select: { absItemId: true } }),
  ]);
  const linkedEbookIds = new Set<string>(existingEbookCopies.map((c) => c.absItemId));
  const linkedAudiobookIds = new Set<string>(existingAudiobookCopies.map((c) => c.absItemId));
  const linkedIdSetFor = (mediaType: AbsMediaType): Set<string> =>
    mediaType === "EBOOK" ? linkedEbookIds : linkedAudiobookIds;

  const seenItemIds = new Set<string>();
  let synced = 0;

  for (const { item, mediaType } of pendingItems) {
    seenItemIds.add(item.absItemId);

    const linkedIds = linkedIdSetFor(mediaType);
    if (linkedIds.has(item.absItemId)) {
      synced++;
      continue;
    }

    const match = findBestTitleMatch(books, item.title);
    if (match) {
      await linkItemToExistingBook(match, mediaType, item.absItemId);
    } else {
      const created = await createBookForItem(item, mediaType);
      books.push(created);
    }
    linkedIds.add(item.absItemId);

    synced++;
  }

  const syncedMediaTypes = new Set<AbsMediaType>(pendingItems.map((p) => p.mediaType));

  await removeStaleAbsLinks(seenItemIds, syncedMediaTypes);

  return { synced };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/absSync.test.ts`
Expected: PASS, all 15 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: only pre-existing errors from `duplicates.ts`/`duplicates.test.ts` (fixed in Task 3). No errors in `absSync.ts`/`absSync.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/absSync.ts src/lib/absSync.test.ts
git commit -m "refactor: rewrite absSync.ts to use EbookCopy/AudiobookCopy rows instead of arrays"
```

---

## Task 3: Update `duplicates.ts`'s `mergeBooksData`

**Files:**
- Modify: `src/lib/duplicates.ts`
- Modify: `src/lib/duplicates.test.ts`

- [ ] **Step 1: Write the failing test changes**

In `src/lib/duplicates.test.ts`, three changes:

First, update the `afterEach` cleanup to also remove `ebookCopy`/`audiobookCopy` rows before deleting books (both foreign keys are `ON DELETE RESTRICT`, same as `PhysicalCopy`):

```typescript
afterEach(async () => {
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test Duplicates" } } } });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Duplicates" } } },
  });
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Duplicates" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Duplicates" } } });
});
```

Second, in the `"groups two books with closely-matching titles together when at least one is digitally owned"` test, change how book `b` is created:

```typescript
    const b = await prisma.book.create({
      data: {
        title: "Test Duplicates The Way of Kings",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-group-ebook" } },
      },
    });
```

(was `absEbookItemIds: ["dup-test-group-ebook"]`)

Third, in the `"reports copy count and ebook/audiobook flags per candidate"` test, change the ebook book's creation:

```typescript
    await prisma.book.create({
      data: {
        title: "Test Duplicates Reported Fields Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-ebook-item" } },
      },
    });
```

(was `absEbookItemIds: ["dup-test-ebook-item"]`)

Fourth, replace the `"unions ebook/audiobook flags and item ids from the merged book onto the kept book"` test entirely with:

```typescript
  it("reassigns ebook/audiobook copies from the merged book onto the kept book, recomputing flags", async () => {
    const keep = await prisma.book.create({
      data: {
        title: "Test Duplicates Union Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-keep-ebook" } },
      },
    });
    const merge = await prisma.book.create({
      data: {
        title: "Test Duplicates Union Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "dup-test-merge-audiobook" } },
      },
    });

    const result = await mergeBooksData(keep.id, [merge.id]);

    expect(result).toEqual({ ok: true });
    const kept = await prisma.book.findUniqueOrThrow({
      where: { id: keep.id },
      include: { ebookCopies: true, audiobookCopies: true },
    });
    expect(kept.hasEbook).toBe(true);
    expect(kept.hasAudiobook).toBe(true);
    expect(kept.ebookCopies.map((c) => c.absItemId)).toEqual(["dup-test-keep-ebook"]);
    expect(kept.audiobookCopies.map((c) => c.absItemId)).toEqual(["dup-test-merge-audiobook"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/duplicates.test.ts`
Expected: FAIL — `duplicates.ts` still references `absEbookItemIds`/`absAudiobookItemIds`, which no longer exist.

- [ ] **Step 3: Update `mergeBooksData` in `duplicates.ts`**

Replace the `mergeBooksData` function (everything from `export async function mergeBooksData` to the end of the file) with:

```typescript
// Moves every PhysicalCopy/EbookCopy/AudiobookCopy from `mergeIds` onto
// `keepId`, recomputes hasEbook/hasAudiobook from the post-reassignment row
// counts, then deletes the merged rows. Never touches `keepId`'s own
// title/author/isbn -- same never-overwrite safeguard
// createBookWithCopyData's fuzzy-match fallback uses, so a human confirming
// the wrong pair doesn't also corrupt the surviving row's identity, only
// its ownership data (which is reversible by re-running a sync, unlike
// title/author/isbn).
export async function mergeBooksData(
  keepId: string,
  rawMergeIds: string[],
): Promise<{ ok: true } | { error: string }> {
  // De-duplicated up front: Prisma's `id: { in: [...] }` already de-dupes
  // ids internally, so comparing its result's length against a
  // not-yet-deduplicated input list below would wrongly report "not found"
  // whenever the same id appeared twice in `rawMergeIds`.
  const mergeIds = Array.from(new Set(rawMergeIds));

  if (mergeIds.includes(keepId)) {
    return { error: "Cannot merge a book into itself" };
  }

  const keep = await prisma.book.findUnique({ where: { id: keepId } });
  if (!keep) {
    return { error: "Book to keep was not found" };
  }

  const toMerge = await prisma.book.findMany({ where: { id: { in: mergeIds } } });
  if (toMerge.length !== mergeIds.length) {
    return { error: "One or more books to merge were not found" };
  }

  // Counted before the transaction (rather than inside it) since the array
  // form of $transaction can't read intermediate results of its own
  // operations -- this app is single-user, so nothing else concurrently
  // modifies these specific rows in the interim.
  const [keepEbookCount, keepAudiobookCount, mergeEbookCount, mergeAudiobookCount] =
    await Promise.all([
      prisma.ebookCopy.count({ where: { bookId: keepId } }),
      prisma.audiobookCopy.count({ where: { bookId: keepId } }),
      prisma.ebookCopy.count({ where: { bookId: { in: mergeIds } } }),
      prisma.audiobookCopy.count({ where: { bookId: { in: mergeIds } } }),
    ]);
  const hasEbook = keepEbookCount + mergeEbookCount > 0;
  const hasAudiobook = keepAudiobookCount + mergeAudiobookCount > 0;

  await prisma.$transaction([
    prisma.physicalCopy.updateMany({
      where: { bookId: { in: mergeIds } },
      data: { bookId: keepId },
    }),
    prisma.ebookCopy.updateMany({
      where: { bookId: { in: mergeIds } },
      data: { bookId: keepId },
    }),
    prisma.audiobookCopy.updateMany({
      where: { bookId: { in: mergeIds } },
      data: { bookId: keepId },
    }),
    prisma.book.update({
      where: { id: keepId },
      data: { hasEbook, hasAudiobook },
    }),
    prisma.book.deleteMany({ where: { id: { in: mergeIds } } }),
  ]);

  return { ok: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/duplicates.test.ts`
Expected: PASS, all 12 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors anywhere.

- [ ] **Step 6: Commit**

```bash
git add src/lib/duplicates.ts src/lib/duplicates.test.ts
git commit -m "refactor: reassign EbookCopy/AudiobookCopy rows in mergeBooksData instead of unioning arrays"
```

---

## Task 4: Final Verification Pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including every file touched above.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new errors (2 pre-existing, unrelated issues expected: a `set-state-in-effect` error in `CoverPicker.tsx` and an unused-var warning in `src/lib/actions/copies.ts`).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: production build succeeds.

- [ ] **Step 5: Note remaining manual step**

Live verification (matching every prior phase's pattern) can't be fully done from this sandbox: after this branch is deployed, confirm the real production `Book` rows' ebook/audiobook ownership is unchanged after the migration runs (spot-check a few books that had non-empty arrays before against their new `EbookCopy`/`AudiobookCopy` row counts), then trigger a real ABS sync and confirm it still links/creates/removes correctly against the new tables. Flag this to the user rather than marking it done — it requires the real deployed app and real ABS data.
