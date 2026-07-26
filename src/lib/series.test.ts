import { describe, it, expect } from "vitest";
import { parseSeriesFromTitle } from "@/lib/series";

describe("parseSeriesFromTitle", () => {
  it("parses a real Goodreads series title", () => {
    expect(parseSeriesFromTitle("The City of Brass (The Daevabad Trilogy, #1)")).toEqual({
      seriesName: "The Daevabad Trilogy",
      seriesPosition: 1,
    });
  });

  it("parses a decimal position for a novella", () => {
    expect(parseSeriesFromTitle("Some Novella (Series Name, #1.5)")).toEqual({
      seriesName: "Series Name",
      seriesPosition: 1.5,
    });
  });

  it("trims whitespace around the series name", () => {
    expect(parseSeriesFromTitle("Title (  Spaced Series , #2)")).toEqual({
      seriesName: "Spaced Series",
      seriesPosition: 2,
    });
  });

  it("returns null for a title with no parenthetical", () => {
    expect(parseSeriesFromTitle("Plain Title With No Suffix")).toBeNull();
  });

  it("returns null for an unrelated parenthetical", () => {
    expect(parseSeriesFromTitle("Book Title (Annotated Edition)")).toBeNull();
  });

  it("returns null when the parenthetical has a comma but no #N", () => {
    expect(parseSeriesFromTitle("Title (Something, No Number)")).toBeNull();
  });

  it("returns null when the suffix is not at the end", () => {
    expect(parseSeriesFromTitle("Title (Series, #1) and more text")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseSeriesFromTitle("")).toBeNull();
  });
});
