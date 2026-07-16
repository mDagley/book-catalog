import { describe, it, expect } from "vitest";
import { ratingStars } from "@/components/ReadingProgressFields";

describe("ratingStars", () => {
  it("renders the given number of filled stars out of 5", () => {
    expect(ratingStars(3)).toBe("★★★☆☆");
  });

  it("renders all filled stars for 5", () => {
    expect(ratingStars(5)).toBe("★★★★★");
  });

  it("renders all empty stars for 0", () => {
    expect(ratingStars(0)).toBe("☆☆☆☆☆");
  });

  it("clamps a rating above 5 instead of throwing", () => {
    expect(ratingStars(999)).toBe("★★★★★");
  });

  it("clamps a negative rating instead of throwing", () => {
    expect(ratingStars(-3)).toBe("☆☆☆☆☆");
  });
});
