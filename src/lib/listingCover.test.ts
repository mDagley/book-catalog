import { describe, it, expect } from "vitest";
import { resolveListingCover } from "@/lib/listingCover";

describe("resolveListingCover", () => {
  it("prefers a physical copy's cover over ebook/audiobook", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: "physical.jpg" }],
      ebookCopies: [{ coverImagePath: "ebook.jpg" }],
      audiobookCopies: [{ coverImagePath: "audiobook.jpg" }],
    });
    expect(result).toBe("physical.jpg");
  });

  it("falls back to an ebook cover when no physical copy has one", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }],
      ebookCopies: [{ coverImagePath: "ebook.jpg" }],
      audiobookCopies: [{ coverImagePath: "audiobook.jpg" }],
    });
    expect(result).toBe("ebook.jpg");
  });

  it("falls back to an audiobook cover when neither physical nor ebook has one", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }],
      ebookCopies: [],
      audiobookCopies: [{ coverImagePath: "audiobook.jpg" }],
    });
    expect(result).toBe("audiobook.jpg");
  });

  it("uses the first physical copy with a cover, not necessarily the first copy overall", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }, { coverImagePath: "second.jpg" }],
      ebookCopies: [],
      audiobookCopies: [],
    });
    expect(result).toBe("second.jpg");
  });

  it("returns null when nothing has a cover", () => {
    const result = resolveListingCover({
      copies: [{ coverImagePath: null }],
      ebookCopies: [{ coverImagePath: null }],
      audiobookCopies: [{ coverImagePath: null }],
    });
    expect(result).toBeNull();
  });

  it("returns null for a book with no copies of any type", () => {
    const result = resolveListingCover({ copies: [], ebookCopies: [], audiobookCopies: [] });
    expect(result).toBeNull();
  });
});
