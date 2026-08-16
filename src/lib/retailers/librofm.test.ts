import { describe, it, expect, vi, afterEach } from "vitest";
import { librofmAdapter } from "@/lib/retailers/librofm";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SEARCH_RESULTS_HTML = `
<div class="book-grid-item">
  <a class="book" href="/audiobooks/9781427209764-the-way-of-kings">
    <div class="book-info">
      <div class="title">The Way of Kings</div>
      <div class="author">Brandon Sanderson</div>
    </div>
  </a>
</div>
<div class="book-grid-item">
  <a class="book" href="/audiobooks/9781545920435-the-way-of-kings-devotional">
    <div class="book-info">
      <div class="title">The Way of Kings (Devotional)</div>
      <div class="author">Someone Else</div>
    </div>
  </a>
</div>
`;

const PRODUCT_PAGE_HTML = `
<script type="application/ld+json">
{"@type":"Product","offers":{"@type":"AggregateOffer","lowPrice":"14.99","highPrice":"52.49","priceCurrency":"USD"}}
</script>
`;

describe("librofmAdapter.search", () => {
  it("returns the first search result as the match", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => SEARCH_RESULTS_HTML } as Response);

    const result = await librofmAdapter.search("The Way of Kings", "Brandon Sanderson");

    expect(result).toEqual({
      matchedTitle: "The Way of Kings",
      matchedAuthor: "Brandon Sanderson",
      productUrl: "https://libro.fm/audiobooks/9781427209764-the-way-of-kings",
    });
  });

  it("returns null when the search page has no results", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "<div>no results</div>" } as Response);

    const result = await librofmAdapter.search("Some Nonexistent Book", null);

    expect(result).toBeNull();
  });

  it("throws on a non-OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);

    await expect(librofmAdapter.search("The Way of Kings", null)).rejects.toThrow();
  });
});

describe("librofmAdapter.fetchPrice", () => {
  it("parses offers.highPrice out of the JSON-LD block", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => PRODUCT_PAGE_HTML } as Response);

    const price = await librofmAdapter.fetchPrice("https://libro.fm/audiobooks/9781427209764-the-way-of-kings");

    expect(price).toBe(52.49);
  });

  it("returns null when no JSON-LD block is present", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "<div>gone</div>" } as Response);

    const price = await librofmAdapter.fetchPrice("https://libro.fm/audiobooks/whatever");

    expect(price).toBeNull();
  });
});
