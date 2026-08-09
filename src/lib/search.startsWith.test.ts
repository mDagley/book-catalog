import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog, getAvailableStartsWithLetters, parseStartsWithLetter } from "@/lib/search";

afterEach(async () => {
  // `contains` (not `startsWith`): the startsWith-letter-filter tests below
  // deliberately put fixture titles' target letter as the literal first
  // character (e.g. "Mistborn Test Search Letter Combo"), with the
  // "Test Search" marker elsewhere in the string rather than at the very
  // start. `startsWith` would silently fail to clean those up.
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

describe("searchCatalog startsWith filter", () => {
  it("returns only books whose title starts with the given letter, under title sort", async () => {
    // The target letter must be the fixture title's literal first
    // character -- letterBucket buckets on the whole string's first char
    // (see alphabetize.ts / tbrGap.ts's identical convention), so a shared
    // "Test Search Letter" prefix would bucket every fixture under "T"
    // regardless of the word that follows. "Test Search Letter" is kept in
    // the title (just not at the front) so afterEach's `contains` cleanup
    // still catches it.
    await prisma.book.create({ data: { title: "Mistborn Test Search Letter" } });
    await prisma.book.create({ data: { title: "Elantris Test Search Letter" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      startsWith: { letter: "M", field: "title" },
    });

    const ours = results.filter((r) => r.title.includes("Test Search Letter"));
    expect(ours.map((r) => r.title)).toEqual(["Mistborn Test Search Letter"]);
  });

  it("filters on author, not title, when field is 'author'", async () => {
    await prisma.book.create({ data: { title: "Test Search Letter Author A", author: "Zed Author" } });
    await prisma.book.create({ data: { title: "Test Search Letter Author B", author: "Amy Author" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "author",
      startsWith: { letter: "Z", field: "author" },
    });

    const ours = results.filter((r) => r.title.startsWith("Test Search Letter Author"));
    expect(ours.map((r) => r.title)).toEqual(["Test Search Letter Author A"]);
  });

  it("buckets a diacritic-initial author under its unaccented letter", async () => {
    await prisma.book.create({
      data: { title: "Test Search Letter Diacritic Book", author: "Émile Diacritic Zola" },
    });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "author",
      startsWith: { letter: "E", field: "author" },
    });

    expect(results.map((r) => r.title)).toContain("Test Search Letter Diacritic Book");
  });

  it("buckets a non-letter first character under '#'", async () => {
    await prisma.book.create({ data: { title: "1984 Test Search Letter Hash" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      startsWith: { letter: "#", field: "title" },
    });

    expect(results.map((r) => r.title)).toContain("1984 Test Search Letter Hash");
  });

  it("combines the letter filter with an existing types filter", async () => {
    // Both fixtures start with "M" -- the point of this test is that the
    // second book is excluded by the *types* filter (it's physical-only,
    // no ebook), not by the letter filter, so both must genuinely bucket
    // under "M" for the assertion to mean anything.
    await prisma.book.create({
      data: {
        title: "Mistborn Test Search Letter Combo",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "search-test-letter-combo-ebook" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Man In The High Castle Test Search Letter Combo",
        copies: { create: { format: "PAPERBACK" } },
      },
    });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      types: ["ebook"],
      startsWith: { letter: "M", field: "title" },
    });

    expect(results.map((r) => r.title)).toContain("Mistborn Test Search Letter Combo");
    expect(results.map((r) => r.title)).not.toContain(
      "Man In The High Castle Test Search Letter Combo",
    );
  });

  it("applies the letter filter and sort before the limit", async () => {
    await prisma.book.create({ data: { title: "Mango Test Search Letter Limit" } });
    await prisma.book.create({ data: { title: "Mars Test Search Letter Limit" } });
    await prisma.book.create({ data: { title: "Zebra Test Search Letter Limit" } });

    const results = await searchCatalog({
      browseAll: true,
      sortBy: "title",
      startsWith: { letter: "M", field: "title" },
      limit: 1,
    });

    const ours = results.filter((r) => r.title.includes("Test Search Letter Limit"));
    expect(ours.map((r) => r.title)).toEqual(["Mango Test Search Letter Limit"]);
  });

  it("treats startsWith as an active filter on its own, without browseAll or a query", async () => {
    // Copilot review finding on PR #40: hasNoActiveQuery didn't consider
    // startsWith an active filter, so this returned [] as if nothing was
    // being asked for -- inconsistent with startsWith being a real filter.
    await prisma.book.create({ data: { title: "Mistborn Test Search Letter Standalone" } });
    await prisma.book.create({ data: { title: "Elantris Test Search Letter Standalone" } });

    const results = await searchCatalog({
      sortBy: "title",
      startsWith: { letter: "M", field: "title" },
    });

    const ours = results.filter((r) => r.title.includes("Test Search Letter Standalone"));
    expect(ours.map((r) => r.title)).toEqual(["Mistborn Test Search Letter Standalone"]);
  });
});

describe("getAvailableStartsWithLetters", () => {
  it("returns the distinct sorted letters present, ignoring any active startsWith", async () => {
    await prisma.book.create({ data: { title: "Mango Test Search Letters Available" } });
    await prisma.book.create({ data: { title: "Zebra Test Search Letters Available" } });

    const letters = await getAvailableStartsWithLetters(
      { query: "Test Search Letters Available", browseAll: false },
      "title",
    );

    expect(letters).toEqual(["M", "Z"]);
  });

  it("returns an empty array when nothing matches", async () => {
    const letters = await getAvailableStartsWithLetters(
      { query: "Test Search Letters Nonexistent Zzzzz" },
      "title",
    );

    expect(letters).toEqual([]);
  });

  it("treats startsWith as an active filter on its own, without browseAll or a query", async () => {
    // Uses a letter ("Q") no other fixture in this file starts with, so the
    // unscoped result is precise without needing query/browseAll to narrow it.
    await prisma.book.create({ data: { title: "Quicksilver Test Search Letters Available Standalone" } });

    const letters = await getAvailableStartsWithLetters(
      { sortBy: "title", startsWith: { letter: "Q", field: "title" } },
      "title",
    );

    expect(letters).toEqual(["Q"]);
  });
});

describe("parseStartsWithLetter", () => {
  it("returns undefined for an undefined or empty value", () => {
    expect(parseStartsWithLetter(undefined)).toBeUndefined();
    expect(parseStartsWithLetter("")).toBeUndefined();
  });

  it("uppercases a valid single letter", () => {
    expect(parseStartsWithLetter("m")).toBe("M");
  });

  it("accepts '#'", () => {
    expect(parseStartsWithLetter("#")).toBe("#");
  });

  it("returns undefined for anything else (multi-char, digit, symbol)", () => {
    expect(parseStartsWithLetter("mm")).toBeUndefined();
    expect(parseStartsWithLetter("5")).toBeUndefined();
    expect(parseStartsWithLetter("$")).toBeUndefined();
  });
});
