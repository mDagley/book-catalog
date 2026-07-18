import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { saveCoverImage } from "@/lib/coverStorage";
import {
  fetchGoodreadsPage,
  fetchAllGoodreadsBooks,
  syncGoodreadsTbr,
  type GoodreadsShelf,
} from "@/lib/goodreadsSync";

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
});
