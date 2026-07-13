import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog } from "@/lib/search";

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({ where: { book: { title: { startsWith: "Test Search" } } } });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Search" } } });
  await prisma.absCacheItem.deleteMany({ where: { title: { startsWith: "Test Search" } } });
});

describe("searchCatalog", () => {
  it("returns a merged result when the same book exists as a physical copy and an ABS ebook", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Search Mistborn",
        author: "Brandon Sanderson",
        copies: { create: { format: "PAPERBACK", publisher: "Tor", publishYear: 2010 } },
      },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-mistborn-ebook",
        title: "Test Search Mistborn",
        author: "Brandon Sanderson",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog("Mistborn");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Search Mistborn");
    expect(results[0].physicalCopies).toHaveLength(1);
    expect(results[0].hasEbook).toBe(true);
    expect(results[0].hasAudiobook).toBe(false);

    await prisma.physicalCopy.deleteMany({ where: { bookId: book.id } });
    await prisma.book.delete({ where: { id: book.id } });
  });

  it("does not merge two unrelated titles into one result", async () => {
    await prisma.book.create({ data: { title: "Test Search Alpha" } });
    await prisma.absCacheItem.create({
      data: { absItemId: "search-test-beta", title: "Test Search Beta", mediaType: "EBOOK" },
    });

    const results = await searchCatalog("Test Search");

    expect(results.map((r) => r.title).sort()).toEqual(["Test Search Alpha", "Test Search Beta"]);
  });

  it("returns an empty array for a query matching nothing", async () => {
    const results = await searchCatalog("Test Search Nonexistent Zzzzz");
    expect(results).toEqual([]);
  });
});
