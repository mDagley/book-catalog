import { describe, it, expect, vi, afterEach } from "vitest";
import { googleplayAdapter } from "@/lib/retailers/googleplay";

const originalFetch = global.fetch;
const originalEnv = process.env.GOOGLE_BOOKS_API_KEY;
afterEach(() => {
  global.fetch = originalFetch;
  // Assigning `undefined` back would set the string "undefined" (process.env
  // values are always strings), leaking a truthy key into later tests --
  // delete instead when it was never set.
  if (originalEnv === undefined) {
    delete process.env.GOOGLE_BOOKS_API_KEY;
  } else {
    process.env.GOOGLE_BOOKS_API_KEY = originalEnv;
  }
  vi.restoreAllMocks();
});

function volumesResponse(items: unknown[]) {
  return { ok: true, json: async () => ({ items }) } as Response;
}

describe("googleplayAdapter.search", () => {
  it("returns the first FOR_SALE ebook result", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      volumesResponse([
        {
          volumeInfo: { title: "The Way of Kings", authors: ["Brandon Sanderson"] },
          saleInfo: {
            saleability: "FOR_SALE",
            isEbook: true,
            retailPrice: { amount: 12.99 },
            buyLink: "https://play.google.com/store/books/details?id=abc123",
          },
        },
      ]),
    );

    const result = await googleplayAdapter.search("The Way of Kings", "Brandon Sanderson");

    expect(result).toEqual({
      matchedTitle: "The Way of Kings",
      matchedAuthor: "Brandon Sanderson",
      productUrl: "https://play.google.com/store/books/details?id=abc123",
    });
  });

  it("skips non-FOR_SALE results and returns the first sellable one", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      volumesResponse([
        { volumeInfo: { title: "Preview Only" }, saleInfo: { saleability: "NOT_FOR_SALE" } },
        {
          volumeInfo: { title: "The Way of Kings", authors: ["Brandon Sanderson"] },
          saleInfo: {
            saleability: "FOR_SALE",
            isEbook: true,
            retailPrice: { amount: 12.99 },
            buyLink: "https://play.google.com/store/books/details?id=abc123",
          },
        },
      ]),
    );

    const result = await googleplayAdapter.search("The Way of Kings", "Brandon Sanderson");

    expect(result?.matchedTitle).toBe("The Way of Kings");
  });

  it("returns null when there are no items", async () => {
    global.fetch = vi.fn().mockResolvedValue(volumesResponse([]));

    const result = await googleplayAdapter.search("Some Nonexistent Book", null);

    expect(result).toBeNull();
  });

  it("returns null when no result is FOR_SALE", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      volumesResponse([{ volumeInfo: { title: "X" }, saleInfo: { saleability: "NOT_FOR_SALE" } }]),
    );

    const result = await googleplayAdapter.search("X", null);

    expect(result).toBeNull();
  });

  it("skips a FOR_SALE result that isn't an ebook (e.g. print-only)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      volumesResponse([
        {
          volumeInfo: { title: "Print Only Edition" },
          saleInfo: {
            saleability: "FOR_SALE",
            isEbook: false,
            retailPrice: { amount: 24.99 },
            buyLink: "https://play.google.com/store/books/details?id=print123",
          },
        },
      ]),
    );

    const result = await googleplayAdapter.search("Print Only Edition", null);

    expect(result).toBeNull();
  });
});

describe("googleplayAdapter.fetchPrice", () => {
  it("re-fetches the volume by ID extracted from the stored productUrl and returns retailPrice", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        saleInfo: { saleability: "FOR_SALE", isEbook: true, retailPrice: { amount: 9.99 } },
      }),
    } as Response);

    const price = await googleplayAdapter.fetchPrice(
      "https://play.google.com/store/books/details?id=abc123",
    );

    expect(price).toBe(9.99);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/books/v1/volumes/abc123"),
    );
  });

  it("returns null when the volume is no longer for sale", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ saleInfo: { saleability: "NOT_FOR_SALE" } }),
    } as Response);

    const price = await googleplayAdapter.fetchPrice(
      "https://play.google.com/store/books/details?id=abc123",
    );

    expect(price).toBeNull();
  });

  it("returns null when the volume is for sale but is not an ebook (e.g. print-only)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        saleInfo: { saleability: "FOR_SALE", isEbook: false, retailPrice: { amount: 9.99 } },
      }),
    } as Response);

    const price = await googleplayAdapter.fetchPrice(
      "https://play.google.com/store/books/details?id=abc123",
    );

    expect(price).toBeNull();
  });

  it("returns null when the productUrl has no id param", async () => {
    const price = await googleplayAdapter.fetchPrice("https://play.google.com/store/books/details");

    expect(price).toBeNull();
  });
});
