import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { fetchGoodreadsPage, fetchAllGoodreadsBooks, syncGoodreadsTbr } from "@/lib/goodreadsSync";

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
    </item>
    <item>
      <title>Mistborn</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn></isbn>
      <isbn13></isbn13>
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
    </item>
  </channel>
</rss>`;

describe("fetchGoodreadsPage", () => {
  it("parses title/author/isbn from an RSS page", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", 1);

    expect(books).toEqual([
      { title: "The Way of Kings", author: "Brandon Sanderson", isbn: "9780765326355" },
      { title: "Mistborn", author: "Brandon Sanderson", isbn: null },
    ]);
  });

  it("preserves a leading-zero ISBN-10 as a string when isbn13 is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => LEADING_ZERO_ISBN_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", 1);

    expect(books).toEqual([
      { title: "The Way of Kings", author: "Brandon Sanderson", isbn: "0765326353" },
    ]);
  });

  it("returns an empty array for a shelf page with no items", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", 1);

    expect(books).toEqual([]);
  });

  it("throws a clear error on a non-XML response instead of a raw parser exception", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html>Rate limited</html>",
    } as Response);

    await expect(fetchGoodreadsPage("1993628", 1)).rejects.toThrow(/goodreads/i);
  });

  it("requests the to-read shelf with the expected query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);
    global.fetch = fetchMock;

    await fetchGoodreadsPage("1993628", 3);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/review/list_rss/1993628");
    expect(calledUrl.searchParams.get("shelf")).toBe("to-read");
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

    const books = await fetchAllGoodreadsBooks("1993628");

    expect(books).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("syncGoodreadsTbr", () => {
  it("fully replaces GoodreadsTbrItem with the freshly fetched set", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Stale Book No Longer On Shelf", author: "Someone" },
    });

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_RSS_PAGE } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);

    const result = await syncGoodreadsTbr("1993628");

    expect(result).toEqual({ synced: 2 });

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.title === "Stale Book No Longer On Shelf")).toBe(false);
    expect(items.some((i) => i.title === "The Way of Kings")).toBe(true);
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
});
