// Faithful TypeScript port of ../audiobook-compare/compare_audiobooks.py's
// normalize_title / strip_series_suffix / _title_forms / find_best_match_score,
// including a hand-rolled port of Python's difflib.SequenceMatcher.ratio()
// (what thefuzz.fuzz.ratio() calls under the hood) — NOT a Levenshtein ratio,
// which would score differently. This logic is already tuned against the
// user's real Goodreads/ABS data; don't change the algorithm without also
// re-validating MATCH_THRESHOLD in the callers that use it.

export const DEFAULT_MATCH_THRESHOLD = 85;

const CHAR_MAP: Record<string, string> = {
  ø: "o",
  ö: "o",
  ô: "o",
  å: "a",
  ä: "a",
  â: "a",
  ñ: "n",
  ß: "ss",
};

export function normalizeTitle(title: string): string {
  let result = title.toLowerCase();
  for (const [char, replacement] of Object.entries(CHAR_MAP)) {
    result = result.split(char).join(replacement);
  }
  // Decompose remaining accented characters (NFKD) and drop anything that
  // doesn't reduce to plain ASCII.
  result = result
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  result = result.replace(/_/g, " ");
  result = result.replace(/[^a-z0-9\s]/g, "");
  result = result.replace(/\s+/g, " ").trim();
  return result;
}

export function stripSeriesSuffix(title: string): string {
  let result = title;
  result = result.replace(/\s*\([^)]+\)\s*$/, "");
  result = result.replace(/:\s*.+,\s*Book\s+\d+\s*$/i, "");
  result = result.replace(/,\s*Book\s+\d+\s*$/i, "");
  return result.trim();
}

export function titleForms(title: string): string[] {
  const forms = new Set<string>();
  const stripped = stripSeriesSuffix(title);

  forms.add(normalizeTitle(title));
  forms.add(normalizeTitle(stripped));

  if (stripped.includes(":")) {
    const idx = stripped.indexOf(":");
    const before = stripped.slice(0, idx).trim();
    const after = stripped.slice(idx + 1).trim();
    forms.add(normalizeTitle(before));
    forms.add(normalizeTitle(after));
  }

  for (const form of Array.from(forms)) {
    forms.add(form.replace(/^(the|a|an)\s+/, ""));
  }

  return Array.from(forms);
}

interface MatchBlock {
  aStart: number;
  bStart: number;
  size: number;
}

function findLongestMatch(
  a: string,
  b: string,
  b2j: Map<string, number[]>,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): MatchBlock {
  let bestI = aLo;
  let bestJ = bLo;
  let bestSize = 0;
  let j2len = new Map<number, number>();

  for (let i = aLo; i < aHi; i++) {
    const newJ2Len = new Map<number, number>();
    const indices = b2j.get(a[i]) ?? [];
    for (const j of indices) {
      if (j < bLo) continue;
      if (j >= bHi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newJ2Len.set(j, k);
      if (k > bestSize) {
        bestI = i - k + 1;
        bestJ = j - k + 1;
        bestSize = k;
      }
    }
    j2len = newJ2Len;
  }

  while (bestI > aLo && bestJ > bLo && a[bestI - 1] === b[bestJ - 1]) {
    bestI--;
    bestJ--;
    bestSize++;
  }
  while (
    bestI + bestSize < aHi &&
    bestJ + bestSize < bHi &&
    a[bestI + bestSize] === b[bestJ + bestSize]
  ) {
    bestSize++;
  }

  return { aStart: bestI, bStart: bestJ, size: bestSize };
}

function getMatchingBlocks(a: string, b: string): MatchBlock[] {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const ch = b[j];
    const list = b2j.get(ch);
    if (list) list.push(j);
    else b2j.set(ch, [j]);
  }

  const blocks: MatchBlock[] = [];
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];

  while (queue.length > 0) {
    const [aLo, aHi, bLo, bHi] = queue.pop()!;
    const match = findLongestMatch(a, b, b2j, aLo, aHi, bLo, bHi);
    if (match.size > 0) {
      blocks.push(match);
      if (aLo < match.aStart && bLo < match.bStart) {
        queue.push([aLo, match.aStart, bLo, match.bStart]);
      }
      if (match.aStart + match.size < aHi && match.bStart + match.size < bHi) {
        queue.push([match.aStart + match.size, aHi, match.bStart + match.size, bHi]);
      }
    }
  }

  return blocks;
}

// Port of Python's difflib.SequenceMatcher(None, a, b).ratio() — the
// Ratcliff/Obershelp algorithm (2 * matching-character-count / total length),
// NOT a Levenshtein-distance ratio. thefuzz.fuzz.ratio() is exactly this.
export function sequenceMatcherRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const blocks = getMatchingBlocks(a, b);
  const matches = blocks.reduce((sum, block) => sum + block.size, 0);
  return (2 * matches) / (a.length + b.length);
}

// Character-frequency map, precomputed per string so the bound below stays
// O(|a| + |b|) rather than rebuilding both maps on every comparison.
export function charCounts(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  return counts;
}

// A true UPPER BOUND on sequenceMatcherRatio(a, b) * 100, computed in
// O(|a| + |b|) instead of the ratio's own O(|a| * |b|).
//
// Why it holds: the ratio is 2M / (|a| + |b|), where M is the total size of
// the matching blocks. Those blocks are common substrings, so the characters
// they match form a common subsequence of a and b -- meaning the match's
// character multiset is contained in BOTH strings. Hence
// M <= sum_c min(count_a(c), count_b(c)), and the bound follows directly.
//
// This is a filter on WORK, not on RESULTS: when the bound is below the
// match threshold the real score cannot reach it either, so the pair is
// skipped with no possible change to any match decision. That distinction
// matters here -- two earlier attempts to speed this code up restricted
// which CANDIDATES were compared, and both silently lost real matches (see
// the long comment above reconcileTbrItems in goodreadsSync.ts).
export function scoreUpperBound(
  a: string,
  countsA: Map<string, number>,
  b: string,
  countsB: Map<string, number>,
): number {
  const total = a.length + b.length;
  // Mirrors sequenceMatcherRatio's own two-empty-strings special case.
  if (total === 0) return 100;
  // Cheap length-only bound first, since common <= min(|a|, |b|). Needs no
  // map iteration at all and rejects most pairs on its own. Returning it
  // early yields a LOOSER (never lower) bound than the multiset one, so
  // soundness holds for any caller threshold, including below the default.
  const lengthBound = (200 * Math.min(a.length, b.length)) / total;
  if (lengthBound < DEFAULT_MATCH_THRESHOLD) return lengthBound;

  let common = 0;
  // Iterate the smaller map; the result is symmetric either way.
  const [small, large] = countsA.size <= countsB.size ? [countsA, countsB] : [countsB, countsA];
  for (const [ch, n] of small) {
    const other = large.get(ch);
    if (other !== undefined) common += Math.min(n, other);
  }
  return (200 * common) / total;
}

// Compares every normalized form of titleA against every form of titleB and
// returns the best score, 0-100 (matching thefuzz.fuzz.ratio()'s 0-100 scale).
export function titleMatchScore(titleA: string, titleB: string): number {
  const formsA = titleForms(titleA);
  const formsB = titleForms(titleB);
  let best = 0;
  for (const fa of formsA) {
    for (const fb of formsB) {
      const score = sequenceMatcherRatio(fa, fb) * 100;
      if (score > best) best = score;
    }
  }
  return best;
}

export function isTitleMatch(
  titleA: string,
  titleB: string,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): boolean {
  return titleMatchScore(titleA, titleB) >= threshold;
}

export interface TitleIndex<T> {
  findBest(title: string, threshold?: number): T | null;
}

interface IndexedCandidate<T> {
  candidate: T;
  forms: string[];
  counts: Map<string, number>[];
}

// Builds a reusable match index over `candidates`, precomputing each one's
// titleForms() and per-form character counts ONCE. Callers that match many
// incoming items against the same pool (the sync paths) build this once and
// reuse it, instead of paying the setup cost per item.
//
// Every comparison is gated by scoreUpperBound first, so pairs that cannot
// reach the threshold never run the O(n*m) matching-blocks algorithm.
// Results are identical to a naive full scan by construction -- see
// scoreUpperBound's comment, and the equivalence test in matching.test.ts.
export function createTitleIndex<T extends { title: string }>(candidates: T[]): TitleIndex<T> {
  const indexed: IndexedCandidate<T>[] = candidates.map((candidate) => {
    const forms = titleForms(candidate.title);
    return { candidate, forms, counts: forms.map(charCounts) };
  });

  return {
    findBest(title: string, threshold: number = DEFAULT_MATCH_THRESHOLD): T | null {
      const probeForms = titleForms(title);
      const probeCounts = probeForms.map(charCounts);

      let best: T | null = null;
      let bestScore = -1;
      for (const entry of indexed) {
        let score = 0;
        for (let i = 0; i < entry.forms.length; i++) {
          for (let j = 0; j < probeForms.length; j++) {
            // Skip the expensive ratio when it provably cannot beat what we
            // already have, or cannot reach the threshold at all.
            const bound = scoreUpperBound(
              entry.forms[i],
              entry.counts[i],
              probeForms[j],
              probeCounts[j],
            );
            if (bound < threshold || bound <= score) continue;
            const candidateScore = sequenceMatcherRatio(entry.forms[i], probeForms[j]) * 100;
            if (candidateScore > score) score = candidateScore;
          }
        }
        // `>` not `>=`, matching findBestTitleMatch's original tie-breaking:
        // the FIRST candidate at the best score wins.
        if (score >= threshold && score > bestScore) {
          best = entry.candidate;
          bestScore = score;
        }
      }
      return best;
    },
  };
}

// Scans `candidates` for the best fuzzy title match to `title`, returning
// null if nothing scores at or above `threshold`. Generic over any shape
// that carries a `title` string, so every fuzzy-match-then-attach-or-create
// call site (absSync.ts, goodreadsSync.ts, createBookWithCopyData) shares
// one implementation instead of each maintaining a near-identical private
// copy.
//
// A one-shot wrapper over createTitleIndex. Callers matching MANY titles
// against the SAME pool should build the index once themselves -- this
// rebuilds it on every call.
export function findBestTitleMatch<T extends { title: string }>(
  candidates: T[],
  title: string,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): T | null {
  return createTitleIndex(candidates).findBest(title, threshold);
}
