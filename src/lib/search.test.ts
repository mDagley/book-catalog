import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog, parseFormatParam, parseTypesParam, parseStatusParam } from "@/lib/search";

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Search" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Search" } } });
});

describe("searchCatalog", () => {
  it("returns a book that has both a physical copy and an ebook flag set", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Mistborn",
        author: "Brandon Sanderson",
        hasEbook: true,
        absEbookItemIds: ["search-test-mistborn-ebook"],
        copies: { create: { format: "PAPERBACK", publisher: "Tor", publishYear: 2010 } },
      },
    });

    const results = await searchCatalog({ query: "Mistborn" });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Search Mistborn");
    expect(results[0].physicalCopies).toHaveLength(1);
    expect(results[0].hasEbook).toBe(true);
    expect(results[0].hasAudiobook).toBe(false);
  });

  it("returns an empty array for a query matching nothing", async () => {
    const results = await searchCatalog({ query: "Test Search Nonexistent Zzzzz" });
    expect(results).toEqual([]);
  });

  it("matches a stored normalized ISBN when searching with a hyphenated ISBN", async () => {
    await prisma.book.create({
      data: { title: "Test Search Isbn Book", isbn: "9780765326355" },
    });

    const results = await searchCatalog({ query: "978-0-7653-2635-5" });

    expect(results.map((r) => r.title)).toContain("Test Search Isbn Book");
  });

  it("does not match unrelated books via the ISBN clause when the query has no digits", async () => {
    await prisma.book.create({ data: { title: "Test Search Unrelated Alpha" } });
    await prisma.book.create({ data: { title: "Test Search Unrelated Beta" } });

    const results = await searchCatalog({ query: "Nonexistent Query With No Digits At All" });

    expect(results).toEqual([]);
  });

  it("returns an empty array when there is no query and no filters", async () => {
    const results = await searchCatalog({});
    expect(results).toEqual([]);
  });

  it("supports standalone browse by ownership type with no query text", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Physical Only Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Search Ebook Only Book",
        hasEbook: true,
        absEbookItemIds: ["search-test-ebook-only"],
      },
    });

    const ebookResults = await searchCatalog({ types: ["ebook"] });
    expect(ebookResults.map((r) => r.title)).toContain("Test Search Ebook Only Book");
    expect(ebookResults.map((r) => r.title)).not.toContain("Test Search Physical Only Book");

    const physicalResults = await searchCatalog({ types: ["physical"] });
    expect(physicalResults.map((r) => r.title)).toContain("Test Search Physical Only Book");
    expect(physicalResults.map((r) => r.title)).not.toContain("Test Search Ebook Only Book");
  });

  it("excludes audiobook-only results when types omits audiobook", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Audiobook Only Book",
        hasAudiobook: true,
        absAudiobookItemIds: ["search-test-audiobook-only"],
      },
    });

    const results = await searchCatalog({ types: ["ebook"] });

    expect(results.map((r) => r.title)).not.toContain("Test Search Audiobook Only Book");
  });

  it("excludes a book with zero physical copies from the physical type filter", async () => {
    await prisma.book.create({ data: { title: "Test Search Copyless Book" } });

    const results = await searchCatalog({ types: ["physical"] });

    expect(results.map((r) => r.title)).not.toContain("Test Search Copyless Book");
  });

  it("narrows both inclusion and displayed copies when a format filter is active", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Multi Format Book",
        copies: { create: [{ format: "HARDCOVER" }, { format: "PAPERBACK" }] },
      },
    });

    const results = await searchCatalog({ types: ["physical"], format: "PAPERBACK" });

    const match = results.find((r) => r.title === "Test Search Multi Format Book");
    expect(match).toBeDefined();
    expect(match?.physicalCopies).toHaveLength(1);
    expect(match?.physicalCopies[0].format).toBe("PAPERBACK");
  });

  it("excludes a book with no copy in the requested format", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Hardcover Only Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    const results = await searchCatalog({ types: ["physical"], format: "PAPERBACK" });

    expect(results.map((r) => r.title)).not.toContain("Test Search Hardcover Only Book");
  });

  it("combines a text query with a type filter", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Combo Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Search Combo Ebook",
        hasEbook: true,
        absEbookItemIds: ["search-test-combo-ebook"],
      },
    });

    const results = await searchCatalog({ query: "Test Search Combo", types: ["physical"] });

    expect(results.map((r) => r.title)).toEqual(["Test Search Combo Book"]);
  });

  it("ignores a format filter when types excludes physical entirely", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Format Noop Ebook",
        hasEbook: true,
        absEbookItemIds: ["search-test-format-noop-ebook"],
      },
    });

    const results = await searchCatalog({ types: ["ebook"], format: "PAPERBACK" });

    expect(results.map((r) => r.title)).toContain("Test Search Format Noop Ebook");
  });

  it("hides all of a book's physical copies when physical isn't part of the requested view", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Ebook With Multiple Formats",
        hasEbook: true,
        absEbookItemIds: ["search-test-multi-format-ebook"],
        copies: { create: [{ format: "HARDCOVER" }, { format: "PAPERBACK" }] },
      },
    });

    const results = await searchCatalog({ types: ["ebook"], format: "PAPERBACK" });

    const match = results.find((r) => r.title === "Test Search Ebook With Multiple Formats");
    expect(match).toBeDefined();
    expect(match?.hasEbook).toBe(true);
    expect(match?.physicalCopies).toEqual([]);
  });

  it("hides the audiobook flag when types excludes audiobook, even for a book owned as both", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Both Ebook And Audiobook",
        hasEbook: true,
        absEbookItemIds: ["search-test-both-ebook"],
        hasAudiobook: true,
        absAudiobookItemIds: ["search-test-both-audiobook"],
      },
    });

    const results = await searchCatalog({ types: ["ebook"] });

    const match = results.find((r) => r.title === "Test Search Both Ebook And Audiobook");
    expect(match).toBeDefined();
    expect(match?.hasEbook).toBe(true);
    expect(match?.hasAudiobook).toBe(false);
  });

  it("applies a format filter on its own, with no types specified", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Standalone Format Paperback",
        copies: { create: { format: "PAPERBACK" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Search Standalone Format Hardcover",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    const results = await searchCatalog({ format: "PAPERBACK" });

    expect(results.map((r) => r.title)).toContain("Test Search Standalone Format Paperback");
    expect(results.map((r) => r.title)).not.toContain("Test Search Standalone Format Hardcover");
  });

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
});

describe("parseFormatParam", () => {
  it("returns undefined for an undefined or empty value", () => {
    expect(parseFormatParam(undefined)).toBeUndefined();
    expect(parseFormatParam("")).toBeUndefined();
  });

  it("returns the value for a valid Format", () => {
    expect(parseFormatParam("PAPERBACK")).toBe("PAPERBACK");
  });

  it("returns undefined for an unrecognized value", () => {
    expect(parseFormatParam("NOT_A_FORMAT")).toBeUndefined();
  });
});

describe("parseTypesParam", () => {
  it("returns undefined for an undefined or empty value", () => {
    expect(parseTypesParam(undefined)).toBeUndefined();
    expect(parseTypesParam("")).toBeUndefined();
  });

  it("parses a single value", () => {
    expect(parseTypesParam("ebook")).toEqual(["ebook"]);
  });

  it("parses a comma-separated value (manually-typed/bookmarked URL)", () => {
    expect(parseTypesParam("ebook,audiobook")).toEqual(["ebook", "audiobook"]);
  });

  it("parses an array value (repeated same-name checkboxes)", () => {
    expect(parseTypesParam(["ebook", "physical"])).toEqual(["ebook", "physical"]);
  });

  it("drops unrecognized tokens and keeps valid ones", () => {
    expect(parseTypesParam("ebook,bogus,physical")).toEqual(["ebook", "physical"]);
  });

  it("returns undefined when every token is unrecognized", () => {
    expect(parseTypesParam("bogus,alsobogus")).toBeUndefined();
  });
});

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
