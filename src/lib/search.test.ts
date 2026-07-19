import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
  buildStatusWhere,
} from "@/lib/search";
import { saveCoverImage, deleteCoverImage } from "@/lib/coverStorage";

const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const savedCoverPaths: string[] = [];

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Search" } } },
  });
  await prisma.ebookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Search" } } },
  });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Search" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Search" } } });
  for (const p of savedCoverPaths) {
    await deleteCoverImage(p);
  }
  savedCoverPaths.length = 0;
});

describe("searchCatalog", () => {
  it("returns a book that has both a physical copy and an ebook flag set", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Mistborn",
        author: "Brandon Sanderson",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "search-test-mistborn-ebook" } },
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

  it("returns every book when browseAll is true and no other filters are set", async () => {
    const countBefore = await prisma.book.count();
    await prisma.book.create({ data: { title: "Test Search Browse All One" } });
    await prisma.book.create({ data: { title: "Test Search Browse All Two" } });

    const results = await searchCatalog({ browseAll: true });

    expect(results).toHaveLength(countBefore + 2);
    const titles = results.map((r) => r.title);
    expect(titles).toContain("Test Search Browse All One");
    expect(titles).toContain("Test Search Browse All Two");
  });

  it("still returns an empty array with no filters when browseAll is false or omitted", async () => {
    await prisma.book.create({ data: { title: "Test Search Browse All Omitted" } });

    expect(await searchCatalog({})).toEqual([]);
    expect(await searchCatalog({ browseAll: false })).toEqual([]);
  });

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

  it("defaults to id-ascending order when sortBy is omitted (preserves existing behavior)", async () => {
    const first = await prisma.book.create({ data: { title: "Test Search Sort Order Beta" } });
    const second = await prisma.book.create({ data: { title: "Test Search Sort Order Alpha" } });

    const results = await searchCatalog({ browseAll: true });

    const ourResults = results.filter((r) => r.title.startsWith("Test Search Sort Order"));
    expect(ourResults.map((r) => r.bookId)).toEqual([first.id, second.id]);
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
        ebookCopies: { create: { absItemId: "search-test-ebook-only" } },
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
        audiobookCopies: { create: { absItemId: "search-test-audiobook-only" } },
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
        ebookCopies: { create: { absItemId: "search-test-combo-ebook" } },
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
        ebookCopies: { create: { absItemId: "search-test-format-noop-ebook" } },
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
        ebookCopies: { create: { absItemId: "search-test-multi-format-ebook" } },
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
        ebookCopies: { create: { absItemId: "search-test-both-ebook" } },
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "search-test-both-audiobook" } },
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
        ebookCopies: { create: { absItemId: "search-test-status-ebook" } },
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

  it("ORs status values by default (no statusMode given)", async () => {
    await prisma.book.create({
      data: { title: "Test Search Default Or Read Unrated Book", readStatus: "READ" },
    });

    const results = await searchCatalog({ status: ["reading", "unrated"] });

    // Not "reading", but unrated -- an OR should still include it.
    expect(results.map((r) => r.title)).toContain("Test Search Default Or Read Unrated Book");
  });

  it("ANDs status values together when statusMode is 'and'", async () => {
    await prisma.book.create({
      data: { title: "Test Search And Reading Unrated Book", readStatus: "READING" },
    });
    await prisma.book.create({
      data: { title: "Test Search And Reading Rated Book", readStatus: "READING", rating: 3 },
    });

    const results = await searchCatalog({
      status: ["reading", "unrated"],
      statusMode: "and",
    });

    expect(results.map((r) => r.title)).toContain("Test Search And Reading Unrated Book");
    expect(results.map((r) => r.title)).not.toContain("Test Search And Reading Rated Book");
  });

  it("returns no results when ANDing two status values a single book can never satisfy at once", async () => {
    await prisma.book.create({
      data: { title: "Test Search And Contradiction Book", readStatus: "TO_READ" },
    });

    const results = await searchCatalog({
      status: ["to_read", "reading"],
      statusMode: "and",
    });

    expect(results.map((r) => r.title)).not.toContain("Test Search And Contradiction Book");
  });

  it("resolves a physical-copy cover over an ebook cover in results", async () => {
    const physicalCoverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedCoverPaths.push(physicalCoverPath);
    const ebookCoverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedCoverPaths.push(ebookCoverPath);

    await prisma.book.create({
      data: {
        title: "Test Search Cover Priority Book",
        hasEbook: true,
        ebookCopies: {
          create: { absItemId: "search-test-cover-priority-ebook", coverImagePath: ebookCoverPath },
        },
        copies: { create: { format: "PAPERBACK", coverImagePath: physicalCoverPath } },
      },
    });

    const results = await searchCatalog({ query: "Test Search Cover Priority Book" });

    expect(results[0].coverImagePath).toBe(physicalCoverPath);
  });

  it("returns null coverImagePath when nothing has a cover", async () => {
    await prisma.book.create({
      data: { title: "Test Search No Cover Book", copies: { create: { format: "PAPERBACK" } } },
    });

    const results = await searchCatalog({ query: "Test Search No Cover Book" });

    expect(results[0].coverImagePath).toBeNull();
  });
});

describe("buildStatusWhere", () => {
  it("returns undefined when no status values are given", () => {
    expect(buildStatusWhere(undefined, "or")).toBeUndefined();
  });

  it("returns undefined for an empty status array", () => {
    expect(buildStatusWhere([], "or")).toBeUndefined();
  });

  it("builds an OR clause of readStatus/rating conditions for 'or' mode", () => {
    const where = buildStatusWhere(["reading", "unrated"], "or");
    expect(where).toEqual({
      OR: [{ readStatus: "READING" }, { rating: null }],
    });
  });

  it("builds an AND clause of readStatus/rating conditions for 'and' mode", () => {
    const where = buildStatusWhere(["read", "unrated"], "and");
    expect(where).toEqual({
      AND: [{ readStatus: "READ" }, { rating: null }],
    });
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

describe("parseStatusModeParam", () => {
  it("defaults to 'or' for an undefined value", () => {
    expect(parseStatusModeParam(undefined)).toBe("or");
  });

  it("returns 'and' for 'and'", () => {
    expect(parseStatusModeParam("and")).toBe("and");
  });

  it("returns 'or' for 'or'", () => {
    expect(parseStatusModeParam("or")).toBe("or");
  });

  it("defaults to 'or' for an unrecognized value", () => {
    expect(parseStatusModeParam("bogus")).toBe("or");
  });
});
