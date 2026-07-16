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

// Scans `candidates` for the best fuzzy title match to `title`, returning
// null if nothing scores at or above `threshold`. Generic over any shape
// that carries a `title` string, so both absSync.ts's Book-shaped rows and
// goodreadsSync.ts's Book-shaped rows can share one implementation instead
// of each maintaining a near-identical private copy.
export function findBestTitleMatch<T extends { title: string }>(
  candidates: T[],
  title: string,
  threshold: number = DEFAULT_MATCH_THRESHOLD,
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = titleMatchScore(candidate.title, title);
    if (score >= threshold && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
