import { describe, it, expect } from "vitest";
import {
  normalizeTitle,
  stripSeriesSuffix,
  titleForms,
  sequenceMatcherRatio,
  titleMatchScore,
  isTitleMatch,
  findBestTitleMatch,
  charCounts,
  scoreUpperBound,
  createTitleIndex,
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

describe("scoreUpperBound", () => {
  it("never underestimates the real similarity score", () => {
    // The load-bearing invariant of the whole prefilter design: if the bound
    // is ever BELOW the real score, a true match gets skipped and the sync
    // silently loses data. Exercised over deliberately adversarial pairs --
    // anagrams (identical character multisets, different order) are the
    // worst case for a multiset-based bound.
    const titles = [
      "Mistborn: The Final Empire",
      "Mistborn: The Well of Ascension",
      "The Way of Kings",
      "Way of Kings",
      "Kings of the Way",
      "Café",
      "Cafe",
      "Røverne",
      "A",
      "",
      "The Hitchhiker's Guide to the Galaxy",
      "Hitchhikers Guide to the Galaxy",
      "Piranesi",
      "Parisine",
      "The Empire of Shadow (Shadow Cycle, #1)",
      "The Empire of Shadow",
    ];
    for (const a of titles) {
      for (const b of titles) {
        const bound = scoreUpperBound(a, charCounts(a), b, charCounts(b));
        const actual = sequenceMatcherRatio(a, b) * 100;
        expect(bound).toBeGreaterThanOrEqual(actual - 1e-9);
      }
    }
  });

  it("is tight for identical strings", () => {
    const s = "the way of kings";
    expect(scoreUpperBound(s, charCounts(s), s, charCounts(s))).toBeCloseTo(100, 9);
  });

  it("rejects pairs that differ too much in length to possibly match", () => {
    const a = "dune";
    const b = "the wheel of time book eleven";
    expect(scoreUpperBound(a, charCounts(a), b, charCounts(b))).toBeLessThan(85);
  });

  it("treats two empty strings as a perfect score, matching sequenceMatcherRatio", () => {
    expect(scoreUpperBound("", charCounts(""), "", charCounts(""))).toBe(100);
    expect(sequenceMatcherRatio("", "") * 100).toBe(100);
  });

  it("does not underestimate for strings containing astral (surrogate-pair) characters", () => {
    // sequenceMatcherRatio/getMatchingBlocks index by UTF-16 CODE UNIT
    // (a[i], a.length), but charCounts previously iterated with `for...of`,
    // which walks Unicode CODE POINTS -- a surrogate pair (one emoji, two
    // UTF-16 units) counts as a single entry there but as two units in
    // a.length. That mismatch made the bound's denominator (UTF-16 units)
    // and numerator (code-point multiset overlap) disagree, producing a
    // real underestimate: two identical single-emoji strings score 100 via
    // sequenceMatcherRatio but bounded at 50 before this fix (confirmed
    // empirically before writing this test). Every real caller normalizes
    // through titleForms() first, which strips non-ASCII entirely, so this
    // was unreachable via createTitleIndex/findBestTitleMatch in practice --
    // but charCounts/scoreUpperBound are exported with an unconditional
    // "never underestimates" guarantee, so it must hold for direct callers
    // and future ones too.
    const a = "\u{1F389} Party Book"; // leading emoji, surrogate pair
    const b = "\u{1F389} Party Book";
    const bound = scoreUpperBound(a, charCounts(a), b, charCounts(b));
    const actual = sequenceMatcherRatio(a, b) * 100;
    expect(bound).toBeGreaterThanOrEqual(actual - 1e-9);
  });
});

describe("createTitleIndex", () => {
  // Deliberately includes near-duplicates, a colon-prefix collision, an
  // accent, and a length outlier -- the shapes most likely to expose a
  // prefilter that drops real matches.
  const candidates = [
    { id: "1", title: "Mistborn: The Final Empire" },
    { id: "2", title: "Mistborn: The Well of Ascension" },
    { id: "3", title: "The Way of Kings" },
    { id: "4", title: "Words of Radiance" },
    { id: "5", title: "Café Society" },
    { id: "6", title: "Dune" },
    { id: "7", title: "The Empire of Shadow (Shadow Cycle, #1)" },
  ];

  const probes = [
    "Mistborn: The Final Empire",
    "Mistborn The Final Empire",
    "The Well of Ascension",
    "Way of Kings",
    "The Way of Kings (The Stormlight Archive, #1)",
    "Words of Radiance",
    "Cafe Society",
    "Dune",
    "Dune Messiah",
    "The Empire of Shadow",
    "Something Entirely Unrelated",
    "",
  ];

  // An INDEPENDENT reference implementation: the original unprefiltered
  // findBestTitleMatch, verbatim. It must stay independent -- comparing the
  // index against the real findBestTitleMatch would be circular, since that
  // is now a wrapper around createTitleIndex, and the comparison would hold
  // even with the prefilter completely broken (both sides would return null
  // together). This reference goes through titleMatchScore instead, which
  // the prefilter never touches.
  function naiveFindBest<T extends { title: string }>(
    pool: T[],
    title: string,
    threshold = 85,
  ): T | null {
    let best: T | null = null;
    let bestScore = -1;
    for (const candidate of pool) {
      const score = titleMatchScore(candidate.title, title);
      if (score >= threshold && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  it("returns exactly what an unprefiltered scan returns, for every probe", () => {
    // THE test that protects this design. The index must be a pure
    // performance optimisation -- identical results, same object identity,
    // no exceptions. If this cannot be made to pass, the prefilter is
    // unsound and must not ship.
    const index = createTitleIndex(candidates);
    for (const probe of probes) {
      expect(index.findBest(probe)).toBe(naiveFindBest(candidates, probe));
    }
  });

  it("agrees with an unprefiltered scan at non-default thresholds too", () => {
    const index = createTitleIndex(candidates);
    for (const threshold of [50, 70, 85, 95, 100]) {
      for (const probe of probes) {
        expect(index.findBest(probe, threshold)).toBe(
          naiveFindBest(candidates, probe, threshold),
        );
      }
    }
  });

  it("keeps findBestTitleMatch's public behaviour identical as a wrapper", () => {
    for (const probe of probes) {
      expect(findBestTitleMatch(candidates, probe)).toBe(naiveFindBest(candidates, probe));
    }
  });

  it("is reusable across many lookups without mutating its candidates", () => {
    const snapshot = JSON.stringify(candidates);
    const index = createTitleIndex(candidates);
    for (const probe of probes) index.findBest(probe);
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });

  it("handles an empty candidate list", () => {
    expect(createTitleIndex([]).findBest("anything")).toBeNull();
  });
});
