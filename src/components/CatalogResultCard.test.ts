import { describe, it, expect } from "vitest";
import { buildMetaParts } from "@/components/CatalogResultCard";
import type { SearchResult } from "@/lib/search";

function baseResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "Test Book",
    author: "Test Author",
    bookId: "book-1",
    physicalCopies: [],
    hasEbook: false,
    hasAudiobook: false,
    readStatus: null,
    rating: null,
    coverImagePath: null,
    ...overrides,
  };
}

describe("buildMetaParts", () => {
  it("includes publisher and year for a physical copy in comfortable density", () => {
    const parts = buildMetaParts(
      baseResult({
        physicalCopies: [{ id: "c1", format: "PAPERBACK", publisher: "Tor", publishYear: 2010 }],
      }),
      "comfortable",
    );
    expect(parts.find((p) => p.key === "physical-c1")?.label).toBe("Paperback, Tor 2010");
  });

  it("omits publisher and year for a physical copy in compact density", () => {
    const parts = buildMetaParts(
      baseResult({
        physicalCopies: [{ id: "c1", format: "PAPERBACK", publisher: "Tor", publishYear: 2010 }],
      }),
      "compact",
    );
    expect(parts.find((p) => p.key === "physical-c1")?.label).toBe("Paperback");
  });

  it("includes ebook/audiobook/status/rating parts identically in both densities", () => {
    const result = baseResult({
      hasEbook: true,
      hasAudiobook: true,
      readStatus: "READ",
      rating: 4,
    });
    const comfortable = buildMetaParts(result, "comfortable");
    const compact = buildMetaParts(result, "compact");
    expect(comfortable.map((p) => p.key)).toEqual(["ebook", "audiobook", "status", "rating"]);
    expect(compact.map((p) => p.key)).toEqual(["ebook", "audiobook", "status", "rating"]);
  });

  it("returns an empty array when there is nothing to show", () => {
    expect(buildMetaParts(baseResult(), "comfortable")).toEqual([]);
  });
});
