import { describe, it, expect } from "vitest";
import { parseSeriesFromTitle, sortSeriesMembers } from "@/lib/series";

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

describe("sortSeriesMembers", () => {
  const m = (title: string, seriesPosition: number | null) => ({ id: title, title, seriesPosition });

  it("orders by position ascending", () => {
    expect(sortSeriesMembers([m("C", 3), m("A", 1), m("B", 2)]).map((x) => x.title)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("sorts books with no position after every book that has one", () => {
    expect(sortSeriesMembers([m("NoPos", null), m("First", 1)]).map((x) => x.title)).toEqual([
      "First",
      "NoPos",
    ]);
  });

  it("breaks ties on title", () => {
    expect(sortSeriesMembers([m("Zebra", 1), m("Apple", 1)]).map((x) => x.title)).toEqual([
      "Apple",
      "Zebra",
    ]);
  });

  it("orders several null positions among themselves by title", () => {
    expect(sortSeriesMembers([m("Zebra", null), m("Apple", null)]).map((x) => x.title)).toEqual([
      "Apple",
      "Zebra",
    ]);
  });

  it("handles decimal positions", () => {
    expect(
      sortSeriesMembers([m("Two", 2), m("Novella", 1.5), m("One", 1)]).map((x) => x.title),
    ).toEqual(["One", "Novella", "Two"]);
  });

  it("does not mutate the input array", () => {
    const input = [m("C", 3), m("A", 1)];
    sortSeriesMembers(input);
    expect(input.map((x) => x.title)).toEqual(["C", "A"]);
  });
});
