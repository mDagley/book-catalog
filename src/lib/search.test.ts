import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog, parseFormatParam, parseTypesParam } from "@/lib/search";

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

    const results = await searchCatalog({ query: "Mistborn" });

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

    const results = await searchCatalog({ query: "Test Search" });

    expect(results.map((r) => r.title).sort()).toEqual(["Test Search Alpha", "Test Search Beta"]);
  });

  it("does not let two unmatched ABS items spuriously merge into each other", async () => {
    // Regression test for the O(n^2) merge-loop bug: fuzzy-matching against
    // a growing `results` array let a LATER unmatched absItem accidentally
    // merge into an EARLIER unmatched absItem's standalone entry. Neither
    // of these titles has any matching physical book -- "Test Search Twin
    // Book: Special Edition" fuzzy-matches "Test Search Twin Book" (colon-
    // prefix scoring in matching.ts scores this ~100), so under the old
    // buggy code the second item would incorrectly attach its mediaType
    // onto the first item's standalone entry instead of creating its own.
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-twin-ebook",
        title: "Test Search Twin Book",
        mediaType: "EBOOK",
      },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-twin-audiobook",
        title: "Test Search Twin Book: Special Edition",
        mediaType: "AUDIOBOOK",
      },
    });

    const results = await searchCatalog({ query: "Test Search Twin" });

    expect(results).toHaveLength(2);
    const ebookEntry = results.find((r) => r.title === "Test Search Twin Book");
    const audiobookEntry = results.find(
      (r) => r.title === "Test Search Twin Book: Special Edition",
    );
    expect(ebookEntry?.hasEbook).toBe(true);
    expect(ebookEntry?.hasAudiobook).toBe(false);
    expect(audiobookEntry?.hasEbook).toBe(false);
    expect(audiobookEntry?.hasAudiobook).toBe(true);
  });

  it("attaches the ebook badge to the best-scoring title match, not just the first match above threshold", async () => {
    const weakBook = await prisma.book.create({
      data: { title: "Test Search Mist", author: "Brandon Sanderson" },
    });
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

    const results = await searchCatalog({ query: "Test Search" });

    const weakResult = results.find((r) => r.title === "Test Search Mist");
    const exactResult = results.find((r) => r.title === "Test Search Mistborn: The Final Empire");

    expect(exactResult?.hasEbook).toBe(true);
    expect(weakResult?.hasEbook).toBe(false);

    await prisma.book.delete({ where: { id: weakBook.id } });
    await prisma.book.delete({ where: { id: exactBook.id } });
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
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-ebook-only",
        title: "Test Search Ebook Only Book",
        mediaType: "EBOOK",
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
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-audiobook-only",
        title: "Test Search Audiobook Only Book",
        mediaType: "AUDIOBOOK",
      },
    });

    const results = await searchCatalog({ types: ["ebook"] });

    expect(results.map((r) => r.title)).not.toContain("Test Search Audiobook Only Book");
  });

  it("excludes a book with zero physical copies from the physical type, even with no format set", async () => {
    // Reachable in practice: deleteCopyData (src/lib/copies.ts) never cascades
    // to delete the parent Book, so a copyless Book row is a real state.
    await prisma.book.create({ data: { title: "Test Search Copyless Book" } });

    const results = await searchCatalog({ types: ["physical"] });

    expect(results.map((r) => r.title)).not.toContain("Test Search Copyless Book");
  });

  it("narrows both inclusion and displayed copies when a format filter is active", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Search Multi Format Book",
        copies: {
          create: [{ format: "HARDCOVER" }, { format: "PAPERBACK" }],
        },
      },
    });

    const results = await searchCatalog({ types: ["physical"], format: "PAPERBACK" });

    const match = results.find((r) => r.title === "Test Search Multi Format Book");
    expect(match).toBeDefined();
    expect(match?.physicalCopies).toHaveLength(1);
    expect(match?.physicalCopies[0].format).toBe("PAPERBACK");

    await prisma.physicalCopy.deleteMany({ where: { bookId: book.id } });
    await prisma.book.delete({ where: { id: book.id } });
  });

  it("excludes a book with no copy in the requested format", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Search Hardcover Only Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    const results = await searchCatalog({ types: ["physical"], format: "PAPERBACK" });

    expect(results.map((r) => r.title)).not.toContain("Test Search Hardcover Only Book");

    await prisma.physicalCopy.deleteMany({ where: { bookId: book.id } });
    await prisma.book.delete({ where: { id: book.id } });
  });

  it("combines a text query with a type filter", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Combo Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-combo-ebook",
        title: "Test Search Combo Ebook",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog({ query: "Test Search Combo", types: ["physical"] });

    expect(results.map((r) => r.title)).toEqual(["Test Search Combo Book"]);
  });

  it("ignores a format filter when types excludes physical entirely", async () => {
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-format-noop-ebook",
        title: "Test Search Format Noop Ebook",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog({ types: ["ebook"], format: "PAPERBACK" });

    expect(results.map((r) => r.title)).toContain("Test Search Format Noop Ebook");
  });

  it("applies a format filter on its own, with no types specified", async () => {
    const paperback = await prisma.book.create({
      data: {
        title: "Test Search Standalone Format Paperback",
        copies: { create: { format: "PAPERBACK" } },
      },
    });
    const hardcover = await prisma.book.create({
      data: {
        title: "Test Search Standalone Format Hardcover",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    const results = await searchCatalog({ format: "PAPERBACK" });

    expect(results.map((r) => r.title)).toContain("Test Search Standalone Format Paperback");
    expect(results.map((r) => r.title)).not.toContain("Test Search Standalone Format Hardcover");

    await prisma.physicalCopy.deleteMany({ where: { bookId: { in: [paperback.id, hardcover.id] } } });
    await prisma.book.deleteMany({ where: { id: { in: [paperback.id, hardcover.id] } } });
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
