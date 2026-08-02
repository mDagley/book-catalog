import { describe, it, expect } from "vitest";
import { letterBucket, sortLetters } from "@/lib/alphabetize";

describe("letterBucket", () => {
  it("returns the uppercased first letter for a plain ASCII string", () => {
    expect(letterBucket("Elantris")).toBe("E");
  });

  it("buckets an accented first letter under its unaccented equivalent", () => {
    expect(letterBucket("Émile Zola")).toBe("E");
  });

  it("buckets a non-letter first character under '#'", () => {
    expect(letterBucket("1984")).toBe("#");
  });

  it("buckets an empty string under '#'", () => {
    expect(letterBucket("")).toBe("#");
  });
});

describe("sortLetters", () => {
  it("sorts letters alphabetically", () => {
    expect(sortLetters(["M", "A", "Z"])).toEqual(["A", "M", "Z"]);
  });

  it("always places '#' last, even before an earlier-inserted letter", () => {
    expect(sortLetters(["#", "A"])).toEqual(["A", "#"]);
  });

  it("returns an empty array for empty input", () => {
    expect(sortLetters([])).toEqual([]);
  });
});
