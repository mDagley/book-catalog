import { describe, it, expect } from "vitest";
import { normalizeIsbn, isValidIsbn } from "@/lib/isbn";

describe("normalizeIsbn", () => {
  it("strips hyphens and spaces", () => {
    expect(normalizeIsbn("978-0-7653-2635-5")).toBe("9780765326355");
    expect(normalizeIsbn(" 978 0765 326355 ")).toBe("9780765326355");
  });

  it("uppercases an ISBN-10 check digit", () => {
    expect(normalizeIsbn("080442957x")).toBe("080442957X");
  });

  it("returns an empty string when there is nothing ISBN-shaped", () => {
    expect(normalizeIsbn("no digits here")).toBe("");
  });
});

describe("isValidIsbn", () => {
  it("accepts a 13-digit ISBN, hyphenated or bare", () => {
    expect(isValidIsbn("9780765326355")).toBe(true);
    expect(isValidIsbn("978-0-7653-2635-5")).toBe(true);
  });

  it("accepts a 10-digit ISBN ending in X", () => {
    expect(isValidIsbn("080442957X")).toBe(true);
    expect(isValidIsbn("080442957x")).toBe(true);
  });

  it("rejects wrong-length and non-ISBN input", () => {
    expect(isValidIsbn("12345")).toBe(false);
    expect(isValidIsbn("")).toBe(false);
    // A UPC/retail barcode a scanner can pick up instead of the ISBN.
    expect(isValidIsbn("012345678905")).toBe(false);
  });
});
