// src/lib/absSync.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { fetchAbsLibraries, fetchAbsLibraryItems, syncAbsCache } from "@/lib/absSync";
import { searchCatalog } from "@/lib/search";
import { deleteCoverImage, saveCoverImage } from "@/lib/coverStorage";

const originalFetch = global.fetch;
const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// Explicitly cleaned up in afterEach (not left to cleanupTestAbsSyncBooks,
// which only touches DB rows) so a test whose own assertion fails --
// i.e. the fix under test regressing -- doesn't leak the file it wrote.
const savedCoverPaths: string[] = [];

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
  for (const p of savedCoverPaths) {
    await deleteCoverImage(p);
  }
  savedCoverPaths.length = 0;
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

  it("does not create a duplicate row or crash when a concurrent sync run already linked the item", async () => {
    const existing = await prisma.book.create({
      data: { title: "Test Abs Sync Race Book" },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          { id: "test-race-1", media: { metadata: { title: "Test Abs Sync Race Book" } } },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    // Simulate another sync run (e.g. cron overlapping a manual refresh)
    // linking this exact ABS item to a different book right as this pass's
    // own write is about to happen -- the real unique constraint on
    // absItemId is what turns this into a P2002 the code must swallow.
    const other = await prisma.book.create({ data: { title: "Test Abs Sync Race Concurrent" } });
    const transactionSpy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce(async (arg) => {
        await prisma.ebookCopy.create({ data: { bookId: other.id, absItemId: "test-race-1" } });
        return prisma.$transaction(arg as never);
      });

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 1 });
    const copies = await prisma.ebookCopy.findMany({ where: { absItemId: "test-race-1" } });
    expect(copies).toHaveLength(1);
    expect(copies[0].bookId).toBe(other.id);
    const unchanged = await prisma.book.findUniqueOrThrow({ where: { id: existing.id } });
    expect(unchanged.hasEbook).toBe(false);
    transactionSpy.mockRestore();
  });

  it("does not swallow a P2002 that isn't the absItemId constraint", async () => {
    await prisma.book.create({ data: { title: "Test Abs Sync Unrelated Constraint" } });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-unrelated-p2002",
            media: { metadata: { title: "Test Abs Sync Unrelated Constraint" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    const fakeError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { driverAdapterError: { cause: { constraint: { fields: ['"title"'] } } } },
    });
    const transactionSpy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(fakeError);

    await expect(syncAbsCache("https://abs.example.com", "token")).rejects.toThrow(
      "Unique constraint failed",
    );
    transactionSpy.mockRestore();
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

  it("deletes the cover file when a stale ebook copy is removed", async () => {
    const coverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedCoverPaths.push(coverPath);
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Stale Ebook Cover Cleanup",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-stale-ebook-cover-1", coverImagePath: coverPath } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-stale-ebook-cover-other",
            media: { metadata: { title: "Test Abs Sync Stale Ebook Cover Unrelated" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    await expect(readFile(path.join(uploadsDir, coverPath))).rejects.toThrow();
  });

  it("deletes the cover file when a stale audiobook copy is removed", async () => {
    const coverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedCoverPaths.push(coverPath);
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Stale Audiobook Cover Cleanup",
        hasAudiobook: true,
        audiobookCopies: {
          create: { absItemId: "test-stale-audiobook-cover-1", coverImagePath: coverPath },
        },
      },
    });

    mockLibrariesAndItems(
      {
        "audio-lib": [
          {
            id: "test-stale-audiobook-cover-other",
            media: { metadata: { title: "Test Abs Sync Stale Audiobook Cover Unrelated" } },
          },
        ],
      },
      [{ id: "audio-lib", name: "Panda Audiobooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    await expect(readFile(path.join(uploadsDir, coverPath))).rejects.toThrow();
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
