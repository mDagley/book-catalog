import { describe, it, expect } from "vitest";
import {
  normalizeTitle,
  stripSeriesSuffix,
  titleForms,
  sequenceMatcherRatio,
  titleMatchScore,
  isTitleMatch,
  findBestTitleMatch,
} from "@/lib/matching";

describe("normalizeTitle", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTitle("The Way of Kings!")).toBe("the way of kings");
  });

  it("decomposes accented characters", () => {
    expect(normalizeTitle("Café")).toBe("cafe");
  });

  it("maps characters with no ASCII NFKD decomposition", () => {
    expect(normalizeTitle("Røverne")).toBe("roverne");
    expect(normalizeTitle("Straße")).toBe("strasse");
  });

  it("collapses underscores and repeated whitespace", () => {
    expect(normalizeTitle("some_title   with  spaces")).toBe("some title with spaces");
  });
});

describe("stripSeriesSuffix", () => {
  it("removes a trailing parenthetical", () => {
    expect(stripSeriesSuffix("Mistborn (The Mistborn Saga, #1)")).toBe("Mistborn");
  });

  it("removes ': Subtitle, Book N'", () => {
    expect(stripSeriesSuffix("The Farseer: Assassin's Apprentice, Book 1")).toBe(
      "The Farseer",
    );
  });

  it("removes ', Book N' without a colon", () => {
    expect(stripSeriesSuffix("Assassin's Apprentice, Book 1")).toBe("Assassin's Apprentice");
  });

  it("leaves a plain title unchanged", () => {
    expect(stripSeriesSuffix("The Way of Kings")).toBe("The Way of Kings");
  });
});

describe("titleForms", () => {
  it("includes both sides of a colon-split title", () => {
    const forms = titleForms("Mistborn: The Final Empire");
    expect(forms).toContain(normalizeTitle("Mistborn"));
    expect(forms).toContain(normalizeTitle("The Final Empire"));
  });

  it("includes article-stripped variants", () => {
    const forms = titleForms("The Mad Ship");
    expect(forms).toContain("mad ship");
    expect(forms).toContain("the mad ship");
  });
});

describe("sequenceMatcherRatio", () => {
  it("returns 1 for identical strings", () => {
    expect(sequenceMatcherRatio("abc", "abc")).toBe(1);
  });

  it("returns 1 for two empty strings", () => {
    expect(sequenceMatcherRatio("", "")).toBe(1);
  });

  it("returns 0 for a string against empty", () => {
    expect(sequenceMatcherRatio("abc", "")).toBe(0);
  });

  it("matches Python difflib.SequenceMatcher(None, 'abc', 'axc').ratio() == 0.6667", () => {
    expect(sequenceMatcherRatio("abc", "axc")).toBeCloseTo(2 / 3, 4);
  });

  it("matches Python difflib.SequenceMatcher(None, 'hello world', 'hello there').ratio() == 0.6364", () => {
    expect(sequenceMatcherRatio("hello world", "hello there")).toBeCloseTo(0.636363636, 4);
  });
});

describe("titleMatchScore / isTitleMatch", () => {
  it("scores an exact title match at 100", () => {
    expect(titleMatchScore("The Way of Kings", "The Way of Kings")).toBe(100);
  });

  it("matches across a series-annotation difference", () => {
    const score = titleMatchScore("Mistborn: The Final Empire", "The Final Empire (Mistborn, #1)");
    expect(score).toBeGreaterThanOrEqual(85);
    expect(isTitleMatch("Mistborn: The Final Empire", "The Final Empire (Mistborn, #1)")).toBe(true);
  });

  it("matches across an article difference", () => {
    expect(isTitleMatch("The Mad Ship", "Mad Ship")).toBe(true);
  });

  it("does not match two unrelated titles", () => {
    expect(isTitleMatch("The Way of Kings", "Pride and Prejudice")).toBe(false);
  });

  it("respects a custom threshold", () => {
    const score = titleMatchScore("The Hobbit", "The Hobbitt");
    expect(isTitleMatch("The Hobbit", "The Hobbitt", 100)).toBe(false);
    expect(isTitleMatch("The Hobbit", "The Hobbitt", Math.floor(score))).toBe(true);
  });
});

describe("findBestTitleMatch", () => {
  interface Candidate {
    id: string;
    title: string;
  }

  it("returns the candidate whose title best matches, above threshold", () => {
    const candidates: Candidate[] = [
      { id: "1", title: "The Way of Kings" },
      { id: "2", title: "Mistborn" },
    ];

    const match = findBestTitleMatch(candidates, "the way of kings");

    expect(match?.id).toBe("1");
  });

  it("returns null when no candidate is above threshold", () => {
    const candidates: Candidate[] = [{ id: "1", title: "The Way of Kings" }];

    const match = findBestTitleMatch(candidates, "Completely Unrelated Title Zzz");

    expect(match).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(findBestTitleMatch([], "Anything")).toBeNull();
  });

  it("picks the highest-scoring candidate when more than one is above threshold", () => {
    const candidates: Candidate[] = [
      { id: "close", title: "The Way of Kingz" },
      { id: "exact", title: "The Way of Kings" },
    ];

    const match = findBestTitleMatch(candidates, "The Way of Kings");

    expect(match?.id).toBe("exact");
  });

  it("respects a custom threshold argument", () => {
    const candidates: Candidate[] = [{ id: "1", title: "Somewhat Similar Title" }];

    expect(findBestTitleMatch(candidates, "Somewhat Similar Titlee", 99)).toBeNull();
    expect(findBestTitleMatch(candidates, "Somewhat Similar Titlee", 50)).not.toBeNull();
  });
});
