import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupIsbn } from "@/lib/isbnLookup";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("lookupIsbn", () => {
  it("returns title/author/publisher/publishYear/coverUrl on a successful Open Library response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        "ISBN:9780765326355": {
          title: "The Way of Kings",
          authors: [{ name: "Brandon Sanderson" }],
          publishers: [{ name: "Tor Fantasy" }],
          publish_date: "2011",
          cover: { medium: "https://covers.openlibrary.org/b/id/12345-M.jpg" },
        },
      }),
    } as Response);

    const result = await lookupIsbn("9780765326355");

    expect(result).toEqual({
      title: "The Way of Kings",
      author: "Brandon Sanderson",
      publisher: "Tor Fantasy",
      publishYear: 2011,
      coverUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg",
    });
  });

  it("returns all-null fields when Open Library has no data for the ISBN", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await lookupIsbn("0000000000000");

    expect(result).toEqual({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
  });

  it("returns all-null fields when the Open Library request itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await lookupIsbn("9780765326355");

    expect(result).toEqual({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
  });

  it("extracts a 4-digit year from a messy publish_date string", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        "ISBN:1234567890123": {
          title: "Some Book",
          publish_date: "March 15, 1999",
        },
      }),
    } as Response);

    const result = await lookupIsbn("1234567890123");
    expect(result.publishYear).toBe(1999);
  });
});
