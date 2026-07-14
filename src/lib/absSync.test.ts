// src/lib/absSync.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { fetchAbsLibraries, fetchAbsLibraryItems, syncAbsCache } from "@/lib/absSync";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Abs Sync" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Abs Sync" } } });
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
    await prisma.physicalCopy.deleteMany({
      where: { book: { title: { startsWith: "Test Abs Sync" } } },
    });
    await prisma.book.deleteMany({ where: { title: { startsWith: "Test Abs Sync" } } });
  });

  it("skips fuzzy matching when the item's ID is already linked (fast path)", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Abs Sync Fast Path Book",
        absEbookItemIds: ["test-fastpath-1"],
        hasEbook: true,
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-fastpath-1",
            // Deliberately a non-matching title -- if the fast path didn't
            // short-circuit, this item would either fail to fuzzy-match
            // (leaving it stranded) or corrupt data by matching something
            // else. Neither should happen: the already-linked ID is
            // recognized before any fuzzy matching is attempted.
            media: { metadata: { title: "Completely Unrelated Title" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 1 });
    const unchanged = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(unchanged.title).toBe("Test Abs Sync Fast Path Book");
    expect(unchanged.absEbookItemIds).toEqual(["test-fastpath-1"]);
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
    });
    expect(book.author).toBe("Brandon Sanderson");
    expect(book.hasAudiobook).toBe(true);
    expect(book.absAudiobookItemIds).toEqual(["test-fuzzy-1"]);
    const total = await prisma.book.count({ where: { title: { startsWith: "Test Abs Sync" } } });
    expect(total).toBe(1);
  });

  it("creates a new Book when no existing title matches", async () => {
    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-new-1",
            media: { metadata: { title: "Test Abs Sync Brand New Book", authorName: "New Author" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    const book = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Brand New Book" },
    });
    expect(book.hasEbook).toBe(true);
    expect(book.absEbookItemIds).toEqual(["test-new-1"]);
    expect(book.author).toBe("New Author");
    const copies = await prisma.physicalCopy.count({ where: { bookId: book.id } });
    expect(copies).toBe(0);
  });

  it("links two different audiobook editions of the same title into one Book's array", async () => {
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

    const books = await prisma.book.findMany({ where: { title: "Test Abs Sync Two Editions" } });
    expect(books).toHaveLength(1);
    expect(books[0].absAudiobookItemIds.slice().sort()).toEqual([
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
        absAudiobookItemIds: ["test-partial-keep", "test-partial-stale"],
        hasAudiobook: true,
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

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.absAudiobookItemIds).toEqual(["test-partial-keep"]);
    expect(updated.hasAudiobook).toBe(true);
  });

  it("deletes a Book that ends up with no ebook, audiobook, or physical copy links", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Fully Removed",
        absEbookItemIds: ["test-remove-1"],
        hasEbook: true,
      },
    });

    mockLibrariesAndItems({ "ebook-lib": [] }, [{ id: "ebook-lib", name: "Panda EBooks" }]);

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
        absEbookItemIds: ["test-keep-1"],
        hasEbook: true,
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    mockLibrariesAndItems({ "ebook-lib": [] }, [{ id: "ebook-lib", name: "Panda EBooks" }]);

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.hasEbook).toBe(false);
    expect(updated.absEbookItemIds).toEqual([]);
  });

  it("throws if the ABS instance is unreachable, without touching existing Book rows", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Still Here",
        absEbookItemIds: ["test-unreachable-1"],
        hasEbook: true,
      },
    });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncAbsCache("https://abs.example.com", "token")).rejects.toThrow();

    const stillThere = await prisma.book.findFirstOrThrow({
      where: { title: "Test Abs Sync Still Here" },
    });
    expect(stillThere.absEbookItemIds).toEqual(["test-unreachable-1"]);
  });
});
