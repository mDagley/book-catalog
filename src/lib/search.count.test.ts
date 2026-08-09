import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog, countCatalog } from "@/lib/search";

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

describe("searchCatalog limit validation", () => {
  // Prisma reads a negative `take` as "the last N rows", so passing one
  // through unvalidated would silently return rows from the opposite end of
  // the ordering. Rejecting loudly beats both that and silently dropping the
  // limit (which would run an unbounded full-catalog query).
  it.each([
    ["negative", -5],
    ["zero", 0],
    ["a float", 10.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("throws for %s", async (_label, limit) => {
    await expect(searchCatalog({ browseAll: true, limit })).rejects.toThrow(
      /limit must be a positive integer/,
    );
  });

  it("accepts a positive integer", async () => {
    await expect(searchCatalog({ browseAll: true, limit: 1 })).resolves.toBeInstanceOf(Array);
  });

  it("throws for an invalid limit even with no query or filter active", async () => {
    await expect(searchCatalog({ limit: -5 })).rejects.toThrow(/positive integer/);
  });
});

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

describe("countCatalog with a startsWith filter", () => {
  it("counts only the letter-matching rows, independent of limit", async () => {
    await prisma.book.create({ data: { title: "Mango Test Search Count Letter" } });
    await prisma.book.create({ data: { title: "Mars Test Search Count Letter" } });
    await prisma.book.create({ data: { title: "Zebra Test Search Count Letter" } });

    const count = await countCatalog({
      query: "Test Search Count Letter",
      sortBy: "title",
      startsWith: { letter: "M", field: "title" },
      limit: 1,
    });

    expect(count).toBe(2);
  });

  it("agrees with searchCatalog's row count for a format-only filter (no text query, no startsWith)", async () => {
    // Flagged by Task 4's code review: countCatalog and searchCatalog share
    // buildCatalogWhere, but nothing had actually exercised .count() vs
    // .findMany() agreement on the relation-subquery branch (copies: {
    // some: { format } }) specifically, only the plain-text-query path.
    await prisma.book.create({
      data: { title: "Test Search Count Format Match", copies: { create: { format: "HARDCOVER" } } },
    });
    await prisma.book.create({
      data: { title: "Test Search Count Format NoMatch", copies: { create: { format: "PAPERBACK" } } },
    });

    const results = await searchCatalog({ browseAll: true, format: "HARDCOVER" });
    const count = await countCatalog({ browseAll: true, format: "HARDCOVER" });

    const ourResults = results.filter((r) => r.title.startsWith("Test Search Count Format"));
    expect(count).toBeGreaterThanOrEqual(ourResults.length);
    // A tighter, scoped check: count restricted to just our fixture titles
    // via a query, matching searchCatalog's own row count for the same
    // narrower filter.
    const scopedResults = await searchCatalog({ query: "Test Search Count Format", format: "HARDCOVER" });
    const scopedCount = await countCatalog({ query: "Test Search Count Format", format: "HARDCOVER" });
    expect(scopedCount).toBe(scopedResults.length);
    expect(scopedResults.map((r) => r.title)).toEqual(["Test Search Count Format Match"]);
  });

  it("treats startsWith as an active filter on its own, without browseAll or a query", async () => {
    // Uses a letter ("Q") no other fixture in this file starts with, so the
    // unscoped count is precise without needing query/browseAll to narrow it.
    await prisma.book.create({ data: { title: "Quicksilver Test Search Count Letter Standalone" } });

    const count = await countCatalog({
      sortBy: "title",
      startsWith: { letter: "Q", field: "title" },
    });

    expect(count).toBe(1);
  });
});
