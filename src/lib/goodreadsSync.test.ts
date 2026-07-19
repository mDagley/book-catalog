import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { saveCoverImage, deleteCoverImage } from "@/lib/coverStorage";
import { lookupIsbn } from "@/lib/isbnLookup";
import {
  fetchGoodreadsPage,
  fetchAllGoodreadsBooks,
  syncGoodreadsTbr,
  type GoodreadsShelf,
} from "@/lib/goodreadsSync";

vi.mock("@/lib/isbnLookup", () => ({ lookupIsbn: vi.fn() }));

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SAMPLE_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>The Way of Kings</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn>0765326353</isbn>
      <isbn13>9780765326355</isbn13>
      <user_rating>0</user_rating>
    </item>
    <item>
      <title>Mistborn</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn></isbn>
      <isbn13></isbn13>
      <user_rating>4</user_rating>
    </item>
  </channel>
</rss>`;

const EMPTY_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel></channel></rss>`;

const LEADING_ZERO_ISBN_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>The Way of Kings</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn>0765326353</isbn>
      <isbn13></isbn13>
      <user_rating>0</user_rating>
    </item>
  </channel>
</rss>`;

const LOWERCASE_X_ISBN_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Some Book With An X Check Digit</title>
      <author_name>Some Author</author_name>
      <isbn>043965548x</isbn>
      <isbn13></isbn13>
      <user_rating>0</user_rating>
    </item>
  </channel>
</rss>`;

describe("fetchGoodreadsPage", () => {
  it("parses title/author/isbn/rating from an RSS page", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([
      { title: "The Way of Kings", author: "Brandon Sanderson", isbn: "9780765326355", rating: null },
      { title: "Mistborn", author: "Brandon Sanderson", isbn: null, rating: 4 },
    ]);
  });

  it("preserves a leading-zero ISBN-10 as a string when isbn13 is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => LEADING_ZERO_ISBN_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([
      { title: "The Way of Kings", author: "Brandon Sanderson", isbn: "0765326353", rating: null },
    ]);
  });

  it("uppercases a lowercase ISBN-10 check digit, matching Book row normalization", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => LOWERCASE_X_ISBN_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([
      { title: "Some Book With An X Check Digit", author: "Some Author", isbn: "043965548X", rating: null },
    ]);
  });

  it("treats an out-of-range user_rating as null instead of persisting a bad value", async () => {
    const OUT_OF_RANGE_RATING_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Out Of Range Rating Book</title>
      <author_name>Some Author</author_name>
      <isbn></isbn>
      <isbn13></isbn13>
      <user_rating>9</user_rating>
    </item>
  </channel>
</rss>`;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => OUT_OF_RANGE_RATING_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([
      { title: "Out Of Range Rating Book", author: "Some Author", isbn: null, rating: null },
    ]);
  });

  it("returns an empty array for a shelf page with no items", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", "to-read", 1);

    expect(books).toEqual([]);
  });

  it("throws a clear error on a non-XML response instead of a raw parser exception", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html>Rate limited</html>",
    } as Response);

    await expect(fetchGoodreadsPage("1993628", "to-read", 1)).rejects.toThrow(/goodreads/i);
  });

  it("requests the given shelf with the expected query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);
    global.fetch = fetchMock;

    await fetchGoodreadsPage("1993628", "currently-reading", 3);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/review/list_rss/1993628");
    expect(calledUrl.searchParams.get("shelf")).toBe("currently-reading");
    expect(calledUrl.searchParams.get("page")).toBe("3");
  });
});

describe("fetchAllGoodreadsBooks", () => {
  it("paginates until an empty page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_RSS_PAGE } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);
    global.fetch = fetchMock;

    const books = await fetchAllGoodreadsBooks("1993628", "to-read");

    expect(books).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Builds a minimal shelf RSS page from a list of items -- keeps the
// combined-sync tests below (which each need their own distinct fixture
// content per shelf) from repeating large XML string literals.
function buildRssPage(
  items: Array<{ title: string; author?: string; isbn13?: string; rating?: number }>,
): string {
  const itemsXml = items
    .map(
      (i) => `
    <item>
      <title>${i.title}</title>
      <author_name>${i.author ?? ""}</author_name>
      <isbn13>${i.isbn13 ?? ""}</isbn13>
      <user_rating>${i.rating ?? 0}</user_rating>
    </item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>${itemsXml}</channel></rss>`;
}

// Mocks global.fetch to serve different, independently-paginating content per
// shelf, keyed off the real `shelf` query param syncGoodreadsTbr's three
// fetchAllGoodreadsBooks calls each send -- far less fragile than a single
// positional mockResolvedValueOnce chain once three shelves are in flight at
// once. Each shelf not given an explicit page list serves EMPTY_RSS_PAGE
// (and any shelf runs out of configured pages, it also falls back to empty,
// which is exactly what real pagination termination looks like).
function mockShelfFetch(pages: Partial<Record<GoodreadsShelf, string[]>>): void {
  const cursors: Partial<Record<GoodreadsShelf, number>> = {};
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const shelf = url.searchParams.get("shelf") as GoodreadsShelf;
    const shelfPages = pages[shelf];
    const cursor = cursors[shelf] ?? 0;
    cursors[shelf] = cursor + 1;
    const text = shelfPages?.[cursor] ?? EMPTY_RSS_PAGE;
    return { ok: true, text: async () => text } as Response;
  });
}

describe("syncGoodreadsTbr", () => {
  // These tests exercise syncGoodreadsTbr's real full-table-replace
  // (GoodreadsTbrItem) and real Book-matching behavior directly against the
  // real dev Postgres (not a mock) -- see the memory note on this file's
  // history for why GoodreadsTbrItem gets snapshotted/restored. Book rows
  // are NOT snapshotted/restored wholesale (unlike GoodreadsTbrItem) --
  // instead, exactly like absSync.test.ts's own established convention,
  // every Book fixture used here is created with a distinctive
  // "Test Goodreads Sync ..." title prefix that cannot plausibly fuzzy-match
  // any of the user's real book titles, and cleaned up afterward by that
  // prefix. This is deliberately simpler than a full-table Book snapshot,
  // and matches how absSync.test.ts already protects real data.
  let realDataSnapshot: Array<{
    id: string;
    title: string;
    author: string | null;
    isbn: string | null;
    coverImagePath: string | null;
    coverCheckedAt: Date | null;
    lastSyncedAt: Date;
  }> = [];

  beforeEach(async () => {
    realDataSnapshot = await prisma.goodreadsTbrItem.findMany({
      select: {
        id: true,
        title: true,
        author: true,
        isbn: true,
        coverImagePath: true,
        coverCheckedAt: true,
        lastSyncedAt: true,
      },
    });
    // vi.restoreAllMocks() in the top-level afterEach clears call history
    // for spies, but this file's `describe`-scoped ordering means it's not
    // guaranteed to run before the NEXT test's assertions build on a fresh
    // mock -- explicitly reset here so no test's lookupIsbn call count or
    // resolved value can leak into another (this matters most for the
    // "caps at 25" test's exact toHaveBeenCalledTimes assertion). Every
    // syncGoodreadsTbr call now runs fetchMissingTbrCovers internally, so
    // ANY test whose fixtures leave an ISBN-bearing, never-checked TBR row
    // behind (not just the cover-fetch tests below) will invoke this mock --
    // default it to "no cover found" so pre-existing tests that don't care
    // about cover-fetching aren't left calling an unmocked-for-this-test
    // function and blowing up on `undefined`.
    vi.mocked(lookupIsbn).mockReset().mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
  });

  afterEach(async () => {
    if (realDataSnapshot.length > 0) {
      await prisma.$transaction([
        prisma.goodreadsTbrItem.deleteMany(),
        prisma.goodreadsTbrItem.createMany({ data: realDataSnapshot }),
      ]);
    } else {
      await prisma.goodreadsTbrItem.deleteMany();
    }
    await prisma.book.deleteMany({ where: { title: { startsWith: "Test Goodreads Sync" } } });
  });

  it("fully replaces GoodreadsTbrItem with the freshly fetched to-read set", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Stale Book No Longer On Shelf", author: "Someone" },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync The Way of Kings", author: "Brandon Sanderson" },
        ]),
      ],
    });

    const result = await syncGoodreadsTbr("1993628");

    expect(result).toEqual({ synced: 1 });

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items.some((i) => i.title === "Stale Book No Longer On Shelf")).toBe(false);
    expect(items.some((i) => i.title === "Test Goodreads Sync The Way of Kings")).toBe(true);
  });

  it("leaves the existing cache untouched if Goodreads is unreachable", async () => {
    await prisma.goodreadsTbrItem.deleteMany();
    await prisma.goodreadsTbrItem.create({ data: { title: "Still Here", author: "Someone" } });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncGoodreadsTbr("1993628")).rejects.toThrow();

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Still Here");
  });

  it("sets readStatus and rating on an existing Book matched from the currently-reading shelf", async () => {
    const book = await prisma.book.create({
      data: { title: "Test Goodreads Sync Currently Reading Book" },
    });

    mockShelfFetch({
      "currently-reading": [
        buildRssPage([{ title: "Test Goodreads Sync Currently Reading Book", rating: 4 }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READING");
    expect(updated.rating).toBe(4);
    expect(updated.readStatusManual).toBe(false);
    expect(updated.ratingManual).toBe(false);
  });

  it("sets READ status when a book appears on the read shelf, overriding an earlier-processed to-read match", async () => {
    const book = await prisma.book.create({
      data: { title: "Test Goodreads Sync Multi Shelf Book" },
    });

    // Same book listed on both shelves in one sync (atypical but possible) --
    // per the design spec, whichever shelf is processed last wins. Shelves
    // are always processed to-read, then currently-reading, then read.
    mockShelfFetch({
      "to-read": [buildRssPage([{ title: "Test Goodreads Sync Multi Shelf Book" }])],
      read: [buildRssPage([{ title: "Test Goodreads Sync Multi Shelf Book", rating: 5 }])],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(5);
  });

  it("does not overwrite a manually-set readStatus, but still syncs rating if rating isn't manual", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Goodreads Sync Manual Status Book",
        readStatus: "READ",
        readStatusManual: true,
      },
    });

    mockShelfFetch({
      "currently-reading": [
        buildRssPage([{ title: "Test Goodreads Sync Manual Status Book", rating: 4 }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(4);
  });

  it("does not overwrite a manually-set rating, but still syncs readStatus if status isn't manual", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Goodreads Sync Manual Rating Book",
        rating: 2,
        ratingManual: true,
      },
    });

    mockShelfFetch({
      read: [buildRssPage([{ title: "Test Goodreads Sync Manual Rating Book", rating: 5 }])],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(2);
  });

  it("does not clear an existing rating when a later-synced shelf item has no rating", async () => {
    const book = await prisma.book.create({
      data: { title: "Test Goodreads Sync Preserve Rating Book", rating: 3 },
    });

    mockShelfFetch({
      read: [buildRssPage([{ title: "Test Goodreads Sync Preserve Rating Book" }])], // rating omitted -> 0 -> null
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.rating).toBe(3);
  });

  it("ignores a shelf item with no matching Book -- creates nothing", async () => {
    mockShelfFetch({
      read: [buildRssPage([{ title: "Test Goodreads Sync Unowned Book" }])],
    });

    await syncGoodreadsTbr("1993628");

    const found = await prisma.book.findMany({
      where: { title: "Test Goodreads Sync Unowned Book" },
    });
    expect(found).toEqual([]);
  });

  it("preserves an existing item's id and coverImagePath when it's matched by ISBN across a sync", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Old Title",
        author: "Old Author",
        isbn: "9780765326355",
        coverImagePath: "some-cover.jpg",
      },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          {
            title: "Test Goodreads Sync New Title",
            author: "New Author",
            isbn13: "9780765326355",
          },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(existing.id);
    expect(items[0].coverImagePath).toBe("some-cover.jpg");
    expect(items[0].title).toBe("Test Goodreads Sync New Title");
    expect(items[0].author).toBe("New Author");
  });

  it("preserves an existing item's id and coverImagePath when matched by fuzzy title (no ISBN)", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync The Way of Kings",
        author: "Brandon Sanderson",
        coverImagePath: "way-of-kings-cover.jpg",
      },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync The Way of Kings", author: "Brandon Sanderson" },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(existing.id);
    expect(items[0].coverImagePath).toBe("way-of-kings-cover.jpg");
  });

  it("deletes an existing item's cover file when the item is removed from the shelf", async () => {
    const coverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Goodreads Sync Removed Book", coverImagePath: coverPath },
    });

    mockShelfFetch({ "to-read": [] });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items.some((i) => i.title === "Test Goodreads Sync Removed Book")).toBe(false);
    await expect(readFile(path.join(uploadsDir, coverPath))).rejects.toThrow();
  });

  it("creates a fresh row for a shelf item with no matching existing row", async () => {
    mockShelfFetch({
      "to-read": [buildRssPage([{ title: "Test Goodreads Sync Brand New Book" }])],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany({
      where: { title: "Test Goodreads Sync Brand New Book" },
    });
    expect(items).toHaveLength(1);
    expect(items[0].coverImagePath).toBeNull();
    expect(items[0].coverCheckedAt).toBeNull();
  });

  it("does not silently drop a book when two incoming shelf items share the same ISBN as one existing row", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Goodreads Sync Old Duplicate ISBN Book", isbn: "9780000000099" },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync Duplicate ISBN Book A", isbn13: "9780000000099" },
          { title: "Test Goodreads Sync Duplicate ISBN Book B", isbn13: "9780000000099" },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany({
      where: { title: { startsWith: "Test Goodreads Sync Duplicate ISBN Book" } },
    });
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.title === "Test Goodreads Sync Duplicate ISBN Book A")).toBe(true);
    expect(items.some((i) => i.title === "Test Goodreads Sync Duplicate ISBN Book B")).toBe(true);
  });

  it("recovers an existing ISBN-bearing row by fuzzy title match when its incoming ISBN no longer matches", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Isbn Drift Book",
        isbn: "9780000000088",
        coverImagePath: "isbn-drift-cover.jpg",
      },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([{ title: "Test Goodreads Sync Isbn Drift Book" }]), // no isbn13 this time
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany({
      where: { title: "Test Goodreads Sync Isbn Drift Book" },
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(existing.id);
    expect(items[0].coverImagePath).toBe("isbn-drift-cover.jpg");
  });

  it("fetches and stores a cover for a new TBR item that has an ISBN", async () => {
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780765326355-M.jpg",
    });
    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync Cover Fetch Book", isbn13: "9780765326355" },
        ]),
      ],
    });
    // mockShelfFetch replaces global.fetch for the RSS calls; saveCoverFromUrl
    // also calls global.fetch for the actual image bytes, so wrap the RSS
    // router to additionally serve a fake image response for the cover URL.
    const rssFetch = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("covers.openlibrary.org")) {
        return {
          ok: true,
          type: "basic",
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          arrayBuffer: async () =>
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
        } as unknown as Response;
      }
      return rssFetch(input as never);
    }) as typeof global.fetch;

    await syncGoodreadsTbr("1993628");

    const item = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync Cover Fetch Book" },
    });
    expect(item.coverImagePath).not.toBeNull();
    expect(item.coverCheckedAt).not.toBeNull();
    if (item.coverImagePath) {
      await deleteCoverImage(item.coverImagePath);
    }
  });

  it("sets coverCheckedAt without a coverImagePath when Open Library has no cover", async () => {
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
    mockShelfFetch({
      "to-read": [
        buildRssPage([{ title: "Test Goodreads Sync No Cover Available", isbn13: "9780000000001" }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const item = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync No Cover Available" },
    });
    expect(item.coverImagePath).toBeNull();
    expect(item.coverCheckedAt).not.toBeNull();
  });

  it("never re-attempts a cover fetch once coverCheckedAt is set, even with no coverImagePath", async () => {
    await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Already Checked",
        isbn: "9780000000002",
        coverCheckedAt: new Date(),
      },
    });
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780000000002-M.jpg",
    });
    mockShelfFetch({
      "to-read": [
        buildRssPage([{ title: "Test Goodreads Sync Already Checked", isbn13: "9780000000002" }]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    expect(lookupIsbn).not.toHaveBeenCalled();
  });

  it("caps the number of cover fetches attempted in a single sync run", async () => {
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `Test Goodreads Sync Cap Book ${i}`,
      isbn13: `978000000${String(i).padStart(4, "0")}`,
    }));
    mockShelfFetch({ "to-read": [buildRssPage(items)] });

    await syncGoodreadsTbr("1993628");

    expect(lookupIsbn).toHaveBeenCalledTimes(25);
  });

  it("does not let an imperfect isbn-less decoy match steal an isbn-drifted item's true match (regression: caught in code review)", async () => {
    // An early version of the performance fix trusted ANY above-threshold
    // tier-1 (isbn-less-pool) match, not just a perfect one. That silently
    // reintroduced the isbn-drift data-loss bug whenever an unrelated
    // isbn-less row happened to score above threshold against the shelf
    // item's title -- exactly what this test constructs.
    const decoy = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync The Way of Kingdoms",
        coverImagePath: "decoy-cover.jpg",
      }, // isbn-less, imperfect (96) match against the shelf item below
    });
    const trueMatch = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync The Way of Kings",
        isbn: "9780000000077",
        coverImagePath: "true-match-cover.jpg",
      },
    });

    // Both books are still on the shelf this sync -- "The Way of Kings" is
    // listed FIRST, with its isbn dropped (drifted/disappeared from the
    // feed), and the decoy's own unchanged shelf entry comes second. This
    // order matters: if the decoy's own perfect self-match were processed
    // first, it would already be claimed (and correctly excluded) by the
    // time "The Way of Kings" is processed, masking the bug this test
    // exists to catch -- caught while writing this test.
    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync The Way of Kings" },
          { title: "Test Goodreads Sync The Way of Kingdoms" },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany({
      where: { title: { startsWith: "Test Goodreads Sync The Way of King" } },
    });
    expect(items).toHaveLength(2);
    // Each row keeps its own id, cover, AND title -- the decoy's near-match
    // score (96, not 100) must not let it steal the true match's shelf
    // entry (which would leave both rows' titles cross-contaminated even
    // though coverImagePath is never touched by an update, so a
    // cover/id-only assertion wouldn't have caught this).
    const trueMatchRow = items.find((i) => i.id === trueMatch.id);
    const decoyRow = items.find((i) => i.id === decoy.id);
    expect(trueMatchRow?.title).toBe("Test Goodreads Sync The Way of Kings");
    expect(trueMatchRow?.coverImagePath).toBe("true-match-cover.jpg");
    expect(decoyRow?.title).toBe("Test Goodreads Sync The Way of Kingdoms");
    expect(decoyRow?.coverImagePath).toBe("decoy-cover.jpg");
  });

  it("does not cross-match two different books that share a series name before a colon (regression: caught in code review)", async () => {
    // titleMatchScore takes the max over every titleForms() variant,
    // including a colon-split prefix -- so "Mistborn: The Final Empire" and
    // "Mistborn: The Well of Ascension" score a PERFECT 100 against each
    // other via the shared "Mistborn" form, despite being two different
    // books. An earlier version of this fix trusted any tier-1 match that
    // scored exactly 100, assuming that meant "the normalized title
    // strings are identical" -- which is false; this is exactly the case
    // that assumption gets wrong. Fixed by using a literal normalizeTitle
    // string-equality check (immune to per-form scoring) instead of relying
    // on titleMatchScore's 100 at all.
    const finalEmpire = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Mistborn: The Final Empire",
        coverImagePath: "final-empire-cover.jpg",
      }, // isbn-less
    });
    const wellOfAscension = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Mistborn: The Well of Ascension",
        isbn: "9780000000066",
        coverImagePath: "well-of-ascension-cover.jpg",
      },
    });

    // "The Well of Ascension" is listed FIRST with its isbn dropped this
    // sync (drift), then "The Final Empire" -- same ordering concern as the
    // decoy test above.
    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync Mistborn: The Well of Ascension" },
          { title: "Test Goodreads Sync Mistborn: The Final Empire" },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const items = await prisma.goodreadsTbrItem.findMany({
      where: { title: { startsWith: "Test Goodreads Sync Mistborn" } },
    });
    expect(items).toHaveLength(2);
    const finalEmpireRow = items.find((i) => i.id === finalEmpire.id);
    const wellOfAscensionRow = items.find((i) => i.id === wellOfAscension.id);
    expect(finalEmpireRow?.title).toBe("Test Goodreads Sync Mistborn: The Final Empire");
    expect(finalEmpireRow?.coverImagePath).toBe("final-empire-cover.jpg");
    expect(wellOfAscensionRow?.title).toBe("Test Goodreads Sync Mistborn: The Well of Ascension");
    expect(wellOfAscensionRow?.coverImagePath).toBe("well-of-ascension-cover.jpg");
  });

  it("stays fast when many isbn-less shelf items need fuzzy matching against a large existing table (regression: production CPU incident)", async () => {
    // Real book titles commonly have colons/subtitles/series suffixes,
    // which titleForms() expands into multiple normalized variants each --
    // that multiplier is what made the original incident's cost so much
    // higher than a naive estimate; a short, punctuation-free synthetic
    // title (tried first while building this test) badly understates it,
    // so this uses shapes closer to real titles instead.
    function realisticTitle(i: number): string {
      const templates = [
        (n: number) => `The Chronicles of Something ${n}: A Tale of Adventure`,
        (n: number) =>
          `An Extremely Long Descriptive Title About Various Topics ${n}: A Subtitle Here`,
        (n: number) => `The Book of ${n} (The Great Series, Book ${n % 12})`,
      ];
      return `Test Goodreads Sync Perf ${templates[i % templates.length](i)}`;
    }

    const isbnBearingCount = 400;
    const isbnLessCount = 60;

    const isbnBearingExisting = Array.from({ length: isbnBearingCount }, (_, i) => ({
      title: realisticTitle(i),
      isbn: `978111${String(i).padStart(7, "0")}`,
    }));
    const isbnLessExisting = Array.from({ length: isbnLessCount }, (_, i) => ({
      title: realisticTitle(i + isbnBearingCount),
    }));
    await prisma.goodreadsTbrItem.createMany({
      data: [...isbnBearingExisting, ...isbnLessExisting],
    });

    // isbn-less items go FIRST in feed order, before any isbn-bearing item
    // has been matched-and-removed from the pool -- a real Goodreads feed
    // has no guaranteed ordering, and putting isbn-bearing items first
    // would let their O(1) isbn matches drain most of the pool before any
    // fuzzy matching even starts, silently making a buggy full-pool
    // fallback look just as fast as the fix (this was tried and caught
    // while writing this test).
    const shelfItems = [
      ...isbnLessExisting.map((item) => ({ title: item.title })),
      ...isbnBearingExisting.map((item) => ({ title: item.title, isbn13: item.isbn })),
    ];
    mockShelfFetch({ "to-read": [buildRssPage(shelfItems)] });

    const start = Date.now();
    await syncGoodreadsTbr("1993628");
    const elapsedMs = Date.now() - start;

    // Measured directly (isolated, this file's matching functions only, not
    // the full sync): tier-1-only fallback (60 isbn-less shelf items x 60
    // isbn-less existing rows, this test's shape after the fix) takes
    // ~360ms; the pre-fix full-pool fallback (60 x the full 460-row table)
    // takes ~4900ms at the same scale with these title shapes. 2000ms is a
    // wide margin on both sides of that gap -- won't flake on a slow CI
    // machine, but reliably catches a regression back to full-pool
    // scanning.
    expect(elapsedMs).toBeLessThan(2000);
  }, 15000);
});
