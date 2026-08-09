import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog, parseSortParam } from "@/lib/search";

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { contains: "Test Search" } } },
  });
  await prisma.ebookCopy.deleteMany({
    where: { book: { title: { contains: "Test Search" } } },
  });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { contains: "Test Search" } } },
  });
  await prisma.book.deleteMany({ where: { title: { contains: "Test Search" } } });
});

describe("searchCatalog sorting", () => {
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

  it("breaks title ties by id ascending, for stable ordering as the catalog grows", async () => {
    // Copilot review finding on PR #29: sorting by title alone doesn't
    // guarantee stable order for two books sharing a title -- Postgres
    // makes no ordering promise among tied rows without a tiebreaker.
    const first = await prisma.book.create({ data: { title: "Test Search Sort Tie" } });
    const second = await prisma.book.create({ data: { title: "Test Search Sort Tie" } });
    const third = await prisma.book.create({ data: { title: "Test Search Sort Tie" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "title" });

    const ourResults = results.filter((r) => r.title === "Test Search Sort Tie");
    expect(ourResults.map((r) => r.bookId)).toEqual([first.id, second.id, third.id]);
  });

  it("returns at most `limit` results when browsing all", async () => {
    await prisma.book.create({ data: { title: "Test Search Limit One" } });
    await prisma.book.create({ data: { title: "Test Search Limit Two" } });
    await prisma.book.create({ data: { title: "Test Search Limit Three" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "title", limit: 2 });

    expect(results).toHaveLength(2);
  });

  it("returns every result when limit is omitted", async () => {
    await prisma.book.create({ data: { title: "Test Search No Limit One" } });
    await prisma.book.create({ data: { title: "Test Search No Limit Two" } });

    const results = await searchCatalog({ browseAll: true, sortBy: "title" });

    expect(results.filter((r) => r.title.startsWith("Test Search No Limit")).length).toBe(2);
  });

  it("defaults to id-ascending order when sortBy is omitted (preserves existing behavior)", async () => {
    const first = await prisma.book.create({ data: { title: "Test Search Sort Order Beta" } });
    const second = await prisma.book.create({ data: { title: "Test Search Sort Order Alpha" } });

    const results = await searchCatalog({ browseAll: true });

    const ourResults = results.filter((r) => r.title.startsWith("Test Search Sort Order"));
    expect(ourResults.map((r) => r.bookId)).toEqual([first.id, second.id]);
  });

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

  it("breaks createdAt-sort ties by id descending", async () => {
    const tiedTimestamp = new Date("2020-01-01T00:00:00Z");
    const first = await prisma.book.create({
      data: { title: "Test Search CreatedAt Tie A", createdAt: tiedTimestamp },
    });
    const second = await prisma.book.create({
      data: { title: "Test Search CreatedAt Tie B", createdAt: tiedTimestamp },
    });

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

  it("breaks rating-sort ties by title, for two books sharing the same rating", async () => {
    await prisma.book.create({ data: { title: "Test Search Rating Tie B", rating: 4 } });
    await prisma.book.create({ data: { title: "Test Search Rating Tie A", rating: 4 } });

    const results = await searchCatalog({ browseAll: true, sortBy: "rating" });

    const ours = results
      .filter((r) => r.title.startsWith("Test Search Rating Tie"))
      .map((r) => r.title);
    expect(ours).toEqual(["Test Search Rating Tie A", "Test Search Rating Tie B"]);
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
});

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
