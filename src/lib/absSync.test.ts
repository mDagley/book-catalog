// src/lib/absSync.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { fetchAbsLibraries, fetchAbsLibraryItems, syncAbsCache } from "@/lib/absSync";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  await prisma.absCacheItem.deleteMany({ where: { absItemId: { startsWith: "test-" } } });
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

describe("syncAbsCache", () => {
  beforeEach(async () => {
    await prisma.absCacheItem.deleteMany({ where: { absItemId: { startsWith: "test-" } } });
  });

  it("upserts EBOOK and AUDIOBOOK items from their respective libraries", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/libraries")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            libraries: [
              { id: "ebook-lib", name: "Panda EBooks" },
              { id: "audio-lib", name: "Panda Audiobooks" },
            ],
          }),
        } as Response);
      }
      if (url.includes("ebook-lib")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "test-ebook-1",
                media: { metadata: { title: "An Ebook", authorName: "E. Author", isbn: "123" } },
              },
            ],
            total: 1,
          }),
        } as Response);
      }
      if (url.includes("audio-lib")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "test-audio-1",
                media: { metadata: { title: "An Audiobook", authorName: "A. Author", isbn: null } },
              },
            ],
            total: 1,
          }),
        } as Response);
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 2 });

    const ebook = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-ebook-1" },
    });
    expect(ebook.mediaType).toBe("EBOOK");
    expect(ebook.title).toBe("An Ebook");
    expect(ebook.isbn).toBe("123");

    const audiobook = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-audio-1" },
    });
    expect(audiobook.mediaType).toBe("AUDIOBOOK");
    expect(audiobook.isbn).toBeNull();
  });

  it("updates lastSyncedAt and metadata on a second sync of the same item", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/libraries")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ libraries: [{ id: "ebook-lib", name: "Panda EBooks" }] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "test-ebook-1",
              media: { metadata: { title: "Renamed Title", authorName: "E. Author", isbn: "123" } },
            },
          ],
          total: 1,
        }),
      } as Response);
    });

    await prisma.absCacheItem.create({
      data: {
        absItemId: "test-ebook-1",
        title: "Old Title",
        author: "E. Author",
        isbn: "123",
        mediaType: "EBOOK",
        lastSyncedAt: new Date(0),
      },
    });

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-ebook-1" },
    });
    expect(updated.title).toBe("Renamed Title");
    expect(updated.lastSyncedAt.getTime()).toBeGreaterThan(0);
  });

  it("throws if the ABS instance is unreachable, without touching existing cache rows", async () => {
    await prisma.absCacheItem.create({
      data: {
        absItemId: "test-ebook-1",
        title: "Still Here",
        mediaType: "EBOOK",
      },
    });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncAbsCache("https://abs.example.com", "token")).rejects.toThrow();

    const stillThere = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-ebook-1" },
    });
    expect(stillThere.title).toBe("Still Here");
  });
});
