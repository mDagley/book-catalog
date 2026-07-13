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

  it("attaches the ebook badge to the best-scoring title match, not just the first match above threshold", async () => {
    // "Test Search Mist" is a weak fuzzy match against the ABS item below
    // (~89 via titleMatchScore) -- it clears DEFAULT_MATCH_THRESHOLD (85) but
    // is not the true match. It is created FIRST so it sorts first under the
    // `orderBy: { id: "asc" }` added to the Book query.
    const weakBook = await prisma.book.create({
      data: { title: "Test Search Mist", author: "Brandon Sanderson" },
    });
    // "Test Search Mistborn: The Final Empire" is the true, exact-title match
    // for the ABS item (100 via titleMatchScore). Created SECOND, so under
    // the old `results.find(isTitleMatch(...))` first-match logic it would
    // never be reached once the weaker match above threshold was found first.
    const exactBook = await prisma.book.create({
      data: { title: "Test Search Mistborn: The Final Empire", author: "Brandon Sanderson" },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-mistborn-best-match-ebook",
        title: "Test Search Mistborn: The Final Empire",
        author: "Brandon Sanderson",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog("Test Search");

    const weakResult = results.find((r) => r.title === "Test Search Mist");
    const exactResult = results.find((r) => r.title === "Test Search Mistborn: The Final Empire");

    expect(exactResult?.hasEbook).toBe(true);
    expect(weakResult?.hasEbook).toBe(false);

    await prisma.book.delete({ where: { id: weakBook.id } });
    await prisma.book.delete({ where: { id: exactBook.id } });
  });

  it("returns an empty array for a query matching nothing", async () => {
    const results = await searchCatalog("Test Search Nonexistent Zzzzz");
    expect(results).toEqual([]);
  });

  it("matches a stored normalized ISBN when searching with a hyphenated ISBN", async () => {
    await prisma.book.create({
      data: { title: "Test Search Isbn Book", isbn: "9780765326355" },
    });

    const results = await searchCatalog("978-0-7653-2635-5");

    expect(results.map((r) => r.title)).toContain("Test Search Isbn Book");
  });

  it("does not match unrelated books via the ISBN clause when the query has no digits", async () => {
    // Regression guard: normalizeIsbn() on a query with no digits/X produces
    // "", and Prisma's `contains: ""` matches every row. Without a guard
    // excluding the ISBN clause in that case, this query would return every
    // book in the table instead of nothing.
    await prisma.book.create({ data: { title: "Test Search Unrelated Alpha" } });
    await prisma.book.create({ data: { title: "Test Search Unrelated Beta" } });

    const results = await searchCatalog("Nonexistent Query With No Digits At All");

    expect(results).toEqual([]);
  });
});
