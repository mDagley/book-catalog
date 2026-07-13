# Phase 4: ABS Sync + Unified Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically populate the catalog with the user's existing ebooks/audiobooks (from their self-hosted Audiobookshelf instance) and Goodreads "to-read" list, replace the home page with a single unified "do I own this?" search across physical books + ABS items, and add a TBR gap view showing which to-read books aren't owned in any format yet — so the user never has to manually re-enter books that already live in ABS or on their Goodreads shelf.

**Architecture:** Two new Prisma-backed cache tables (`AbsCacheItem`, `GoodreadsTbrItem` — already exist in the schema/migration from Phase 1, unused until now) are populated by two sync jobs: an ABS API client (paginated `GET /api/libraries` + `GET /api/libraries/:id/items`) and a Goodreads "to-read" shelf RSS client, both scheduled via `node-cron` registered in `src/instrumentation.ts`, plus a manual "Refresh now" button hitting the same sync logic on demand. A ported fuzzy-title-matching module (`src/lib/matching.ts`, a faithful TypeScript translation of the already-tuned `audiobook-compare/compare_audiobooks.py` — normalized titles, series-suffix stripping, colon/article variants, and a hand-rolled port of Python's `difflib.SequenceMatcher.ratio()` since that's what `thefuzz.fuzz.ratio()` uses under the hood) computes cross-source matches on the fly at query time — nothing about *which* items match is stored. The home page becomes the unified search UI; a new `/tbr` page shows the gap view.

**Tech Stack:** `node-cron` for in-process scheduling (registered via Next.js's `instrumentation.ts` `register()` hook), `fast-xml-parser` for the Goodreads RSS feed, native `fetch` for the ABS API, Vitest for everything except live ABS/Goodreads connectivity (mocked in tests, verified live during implementation against the real instance).

---

## Important context (read before starting)

- **`AbsCacheItem` and `GoodreadsTbrItem` tables already exist** in `prisma/migrations/*/migration.sql` (created in Phase 1 as forward-looking schema, per `prisma/schema.prisma`). No new Prisma migration is needed for this phase — just application code that populates and reads these tables.
- **Real ABS credentials exist** for live verification: `ABS_URL` and `ABS_TOKEN` are already present in a sibling reference project (`../audiobook-compare/.env`, NOT part of this repo) — copy those two values into this repo's own local `.env` (gitignored, never commit them) before starting Task 3's live verification steps. The two ABS libraries to sync are named **"Panda EBooks"** and **"Panda Audiobooks"** (exact names, case-insensitive substring match, matching the existing `audiobook-compare/list_libraries.py` / `compare_audiobooks.py` pattern of filtering by a name substring).
- **The user's Goodreads user ID is `1993628`** (same account referenced in `../audiobook-compare/compare_audiobooks.py`'s hardcoded `GOODREADS_USER_ID`). Add it to this repo's local `.env` as `GOODREADS_USER_ID` — it's personal/account-specific, so it's an env var here, not a hardcoded constant, unlike in the throwaway reference script.
- **The Goodreads shelf is always `"to-read"`**, per the design spec (`docs/superpowers/specs/2026-07-05-book-catalog-design.md`) — this is NOT configurable in this phase (shelf-splitting is an explicit "Deferred / Future Idea" in that spec). Don't add a shelf-selection env var or UI.
- **Do not commit real secrets.** `ABS_URL`/`ABS_TOKEN`/`GOODREADS_USER_ID` go in the local gitignored `.env` only. `.env.example` gets placeholder values, matching the existing pattern for `DATABASE_URL`/`SESSION_SECRET`/`APP_PASSWORD_HASH`.
- **Fuzzy-matching fidelity matters.** The Python reference (`../audiobook-compare/compare_audiobooks.py`) uses `thefuzz.fuzz.ratio()`, which is `2 * matches / (len(a) + len(b))` where `matches` comes from Python's `difflib.SequenceMatcher` (Ratcliff/Obershelp longest-matching-block algorithm), NOT a Levenshtein-distance ratio (those are different algorithms with different scores for the same inputs). Task 2 hand-ports the *exact* `difflib` algorithm rather than substituting a different fuzzy-matching npm package, so the already-tuned `MATCH_THRESHOLD = 85` behaves the same way it does in the Python version. Title strings here are always short (well under Python's 200-character `autojunk` cutoff), so the port doesn't need to replicate `difflib`'s `autojunk` heuristic.
- **This repo's branch-protection rule:** direct pushes to `master` are disallowed. Work happens on a feature branch and merges via PR, matching every other phase in this repo's history.

---

### Task 1: Add dependencies and environment variables

**Files:**
- Modify: `package.json` (add `node-cron`, `fast-xml-parser`, `@types/node-cron`)
- Modify: `.env.example` (add placeholder entries)
- Modify: local `.env` (add real values — not committed)

- [ ] **Step 1: Install dependencies**

```bash
npm install node-cron fast-xml-parser
npm install --save-dev @types/node-cron
```

Expected: `package.json`/`package-lock.json` updated, `node_modules/node-cron` and `node_modules/fast-xml-parser` present.

- [ ] **Step 2: Add placeholder env vars to `.env.example`**

Add these lines after the existing `UPLOADS_DIR` line:

```
# Audiobookshelf instance to sync ebooks/audiobooks from.
ABS_URL="https://your-abs-instance.example.com"
ABS_TOKEN="replace-with-an-abs-api-token"

# Goodreads numeric user ID whose public "to-read" shelf RSS feed gets synced.
GOODREADS_USER_ID="replace-with-your-goodreads-user-id"
```

- [ ] **Step 3: Add real values to the local `.env`**

Read `../audiobook-compare/.env` (a sibling project, NOT part of this repo) to get the real `ABS_URL` and `ABS_TOKEN` values, and add these three lines to this repo's own local `.env` (gitignored — confirm `.env` is NOT tracked by git before proceeding: `git check-ignore .env` should print `.env`):

```
ABS_URL="<copy the real value from ../audiobook-compare/.env>"
ABS_TOKEN="<copy the real value from ../audiobook-compare/.env>"
GOODREADS_USER_ID="1993628"
```

- [ ] **Step 4: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add node-cron, fast-xml-parser dependencies and ABS/Goodreads env vars"
```

(Do not `git add .env` — it's gitignored and must never be committed.)

---

### Task 2: Port the fuzzy title-matching module

**Files:**
- Create: `src/lib/matching.ts`
- Create: `src/lib/matching.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/matching.test.ts
import { describe, it, expect } from "vitest";
import {
  normalizeTitle,
  stripSeriesSuffix,
  titleForms,
  sequenceMatcherRatio,
  titleMatchScore,
  isTitleMatch,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run matching`
Expected: FAIL with "Cannot find module '@/lib/matching'".

- [ ] **Step 3: Implement the matching module**

```typescript
// src/lib/matching.ts

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run matching`
Expected: PASS (all tests in the new file).

Note on the two `toBeCloseTo` reference values in the tests: these are the actual outputs of Python's `difflib.SequenceMatcher(None, "abc", "axc").ratio()` and `difflib.SequenceMatcher(None, "hello world", "hello there").ratio()` — if your port doesn't produce these exact values, the algorithm has a bug; don't adjust the expected values to make a buggy implementation pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/matching.ts src/lib/matching.test.ts
git commit -m "feat: port fuzzy title-matching module from audiobook-compare"
```

---

### Task 3: ABS API client and sync-to-cache logic

**Files:**
- Create: `src/lib/absSync.ts`
- Create: `src/lib/absSync.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/absSync.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { fetchAbsLibraries, fetchAbsLibraryItems, syncAbsCache } from "@/lib/absSync";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  await prisma.absCacheItem.deleteMany({ where: { absItemId: { startsWith: "test-" } } });
});

describe("fetchAbsLibraries", () => {
  it("returns id/name pairs for every library", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        libraries: [
          { id: "lib1", name: "Panda EBooks" },
          { id: "lib2", name: "Panda Audiobooks" },
          { id: "lib3", name: "Someone Else's Comics" },
        ],
      }),
    } as Response);

    const libraries = await fetchAbsLibraries("https://abs.example.com", "token");

    expect(libraries).toEqual([
      { id: "lib1", name: "Panda EBooks" },
      { id: "lib2", name: "Panda Audiobooks" },
      { id: "lib3", name: "Someone Else's Comics" },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://abs.example.com/api/libraries",
      expect.objectContaining({ headers: { Authorization: "Bearer token" } }),
    );
  });
});

describe("fetchAbsLibraryItems", () => {
  it("paginates until an empty results page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "item-1",
              media: { metadata: { title: "Book One", authorName: "Author One", isbn: "111" } },
            },
          ],
          total: 2,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "item-2",
              media: { metadata: { title: "Book Two", authorName: "Author Two", isbn: null } },
            },
          ],
          total: 2,
        }),
      } as Response);
    global.fetch = fetchMock;

    const items = await fetchAbsLibraryItems("https://abs.example.com", "token", "lib1");

    expect(items).toEqual([
      { absItemId: "item-1", title: "Book One", author: "Author One", isbn: "111" },
      { absItemId: "item-2", title: "Book Two", author: "Author Two", isbn: null },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when the first page is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], total: 0 }),
    } as Response);

    const items = await fetchAbsLibraryItems("https://abs.example.com", "token", "lib1");

    expect(items).toEqual([]);
  });
});

describe("syncAbsCache", () => {
  beforeEach(async () => {
    await prisma.absCacheItem.deleteMany({ where: { absItemId: { startsWith: "test-" } } });
  });

  it("upserts EBOOK and AUDIOBOOK items from their respective libraries", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/libraries")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            libraries: [
              { id: "ebook-lib", name: "Panda EBooks" },
              { id: "audio-lib", name: "Panda Audiobooks" },
            ],
          }),
        } as Response);
      }
      if (url.includes("ebook-lib")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "test-ebook-1",
                media: { metadata: { title: "An Ebook", authorName: "E. Author", isbn: "123" } },
              },
            ],
            total: 1,
          }),
        } as Response);
      }
      if (url.includes("audio-lib")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "test-audio-1",
                media: { metadata: { title: "An Audiobook", authorName: "A. Author", isbn: null } },
              },
            ],
            total: 1,
          }),
        } as Response);
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });

    const result = await syncAbsCache("https://abs.example.com", "token");

    expect(result).toEqual({ synced: 2 });

    const ebook = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-ebook-1" },
    });
    expect(ebook.mediaType).toBe("EBOOK");
    expect(ebook.title).toBe("An Ebook");
    expect(ebook.isbn).toBe("123");

    const audiobook = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-audio-1" },
    });
    expect(audiobook.mediaType).toBe("AUDIOBOOK");
    expect(audiobook.isbn).toBeNull();
  });

  it("updates lastSyncedAt and metadata on a second sync of the same item", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/libraries")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ libraries: [{ id: "ebook-lib", name: "Panda EBooks" }] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "test-ebook-1",
              media: { metadata: { title: "Renamed Title", authorName: "E. Author", isbn: "123" } },
            },
          ],
          total: 1,
        }),
      } as Response);
    });

    await prisma.absCacheItem.create({
      data: {
        absItemId: "test-ebook-1",
        title: "Old Title",
        author: "E. Author",
        isbn: "123",
        mediaType: "EBOOK",
        lastSyncedAt: new Date(0),
      },
    });

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-ebook-1" },
    });
    expect(updated.title).toBe("Renamed Title");
    expect(updated.lastSyncedAt.getTime()).toBeGreaterThan(0);
  });

  it("throws if the ABS instance is unreachable, without touching existing cache rows", async () => {
    await prisma.absCacheItem.create({
      data: {
        absItemId: "test-ebook-1",
        title: "Still Here",
        mediaType: "EBOOK",
      },
    });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncAbsCache("https://abs.example.com", "token")).rejects.toThrow();

    const stillThere = await prisma.absCacheItem.findUniqueOrThrow({
      where: { absItemId: "test-ebook-1" },
    });
    expect(stillThere.title).toBe("Still Here");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run absSync`
Expected: FAIL with "Cannot find module '@/lib/absSync'".

- [ ] **Step 3: Implement the ABS sync module**

```typescript
// src/lib/absSync.ts
import { prisma } from "@/lib/prisma";
import type { MediaType } from "@prisma/client";

export interface AbsLibrary {
  id: string;
  name: string;
}

export interface AbsBookItem {
  absItemId: string;
  title: string;
  author: string | null;
  isbn: string | null;
}

const MAX_PAGES = 500; // 500 * 100 = 50,000 items per library, matching the
// audiobook-compare reference script's own safety cap.
const PAGE_LIMIT = 100;

const LIBRARY_MEDIA_TYPES: Record<string, MediaType> = {
  "panda ebooks": "EBOOK",
  "panda audiobooks": "AUDIOBOOK",
};

export async function fetchAbsLibraries(baseUrl: string, token: string): Promise<AbsLibrary[]> {
  const response = await fetch(`${baseUrl}/api/libraries`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ABS libraries: HTTP ${response.status}`);
  }
  const data = await response.json();
  return (data.libraries ?? []).map((lib: { id: string; name: string }) => ({
    id: lib.id,
    name: lib.name,
  }));
}

export async function fetchAbsLibraryItems(
  baseUrl: string,
  token: string,
  libraryId: string,
): Promise<AbsBookItem[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const allItems: AbsBookItem[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${baseUrl}/api/libraries/${libraryId}/items?limit=${PAGE_LIMIT}&page=${page}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch ABS library items: HTTP ${response.status}`);
    }
    const data = await response.json();
    const results = data.results ?? [];
    if (results.length === 0) break;

    for (const item of results) {
      const metadata = item.media?.metadata ?? {};
      allItems.push({
        absItemId: item.id,
        title: metadata.title ?? "",
        author: metadata.authorName ?? null,
        isbn: metadata.isbn ?? null,
      });
    }

    if (allItems.length >= (data.total ?? Infinity)) break;
  }

  return allItems;
}

// Upserts every item from the "Panda EBooks" and "Panda Audiobooks" libraries
// into AbsCacheItem, keyed on absItemId. Does NOT delete cache rows for items
// no longer present in ABS (unlike the Goodreads TBR sync, which does a full
// replace) — per the design spec, ABS sync is upsert-only.
export async function syncAbsCache(
  baseUrl: string,
  token: string,
): Promise<{ synced: number }> {
  const libraries = await fetchAbsLibraries(baseUrl, token);
  let synced = 0;

  for (const library of libraries) {
    const mediaType = LIBRARY_MEDIA_TYPES[library.name.toLowerCase()];
    if (!mediaType) continue;

    const items = await fetchAbsLibraryItems(baseUrl, token, library.id);
    for (const item of items) {
      await prisma.absCacheItem.upsert({
        where: { absItemId: item.absItemId },
        create: {
          absItemId: item.absItemId,
          title: item.title,
          author: item.author,
          isbn: item.isbn,
          mediaType,
        },
        update: {
          title: item.title,
          author: item.author,
          isbn: item.isbn,
          mediaType,
          lastSyncedAt: new Date(),
        },
      });
      synced++;
    }
  }

  return { synced };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run absSync`
Expected: PASS. This test suite hits the real dev Postgres (via `prisma.absCacheItem`), so confirm `docker compose up -d postgres` is running first if the test run fails with a connection error.

- [ ] **Step 5: Verify live against the real ABS instance**

This is a plain HTTP call, not TypeScript-specific — verify with curl directly against the real ABS API, matching exactly what `fetchAbsLibraries` does, without needing to run through the TS module at all:

```bash
source .env 2>/dev/null; curl -s "$ABS_URL/api/libraries" -H "Authorization: Bearer $ABS_TOKEN" | head -c 2000
```

(If your shell doesn't support sourcing `.env` directly because of how values are quoted, just read `ABS_URL`/`ABS_TOKEN` from `.env` and paste them into the command literally instead — don't commit the pasted values anywhere.)

Expected: a real JSON response containing a `"libraries"` array with entries whose `"name"` fields include `Panda EBooks` and `Panda Audiobooks` among the real library names returned.

- [ ] **Step 6: Commit**

```bash
git add src/lib/absSync.ts src/lib/absSync.test.ts
git commit -m "feat: add Audiobookshelf API client and cache sync"
```

---

### Task 4: Goodreads RSS client and TBR sync logic

**Files:**
- Create: `src/lib/goodreadsSync.ts`
- Create: `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/goodreadsSync.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { fetchGoodreadsPage, fetchAllGoodreadsBooks, syncGoodreadsTbr } from "@/lib/goodreadsSync";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

const SAMPLE_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>The Way of Kings</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn>0765326353</isbn>
      <isbn13>9780765326355</isbn13>
    </item>
    <item>
      <title>Mistborn</title>
      <author_name>Brandon Sanderson</author_name>
      <isbn></isbn>
      <isbn13></isbn13>
    </item>
  </channel>
</rss>`;

const EMPTY_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel></channel></rss>`;

describe("fetchGoodreadsPage", () => {
  it("parses title/author/isbn from an RSS page", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", 1);

    expect(books).toEqual([
      { title: "The Way of Kings", author: "Brandon Sanderson", isbn: "9780765326355" },
      { title: "Mistborn", author: "Brandon Sanderson", isbn: null },
    ]);
  });

  it("returns an empty array for a shelf page with no items", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);

    const books = await fetchGoodreadsPage("1993628", 1);

    expect(books).toEqual([]);
  });

  it("throws a clear error on a non-XML response instead of a raw parser exception", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html>Rate limited</html>",
    } as Response);

    await expect(fetchGoodreadsPage("1993628", 1)).rejects.toThrow(/goodreads/i);
  });

  it("requests the to-read shelf with the expected query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => EMPTY_RSS_PAGE,
    } as Response);
    global.fetch = fetchMock;

    await fetchGoodreadsPage("1993628", 3);

    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/review/list_rss/1993628");
    expect(calledUrl.searchParams.get("shelf")).toBe("to-read");
    expect(calledUrl.searchParams.get("page")).toBe("3");
  });
});

describe("fetchAllGoodreadsBooks", () => {
  it("paginates until an empty page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_RSS_PAGE } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);
    global.fetch = fetchMock;

    const books = await fetchAllGoodreadsBooks("1993628");

    expect(books).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("syncGoodreadsTbr", () => {
  it("fully replaces GoodreadsTbrItem with the freshly fetched set", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Stale Book No Longer On Shelf", author: "Someone" },
    });

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_RSS_PAGE } as Response)
      .mockResolvedValueOnce({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);

    const result = await syncGoodreadsTbr("1993628");

    expect(result).toEqual({ synced: 2 });

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.title === "Stale Book No Longer On Shelf")).toBe(false);
    expect(items.some((i) => i.title === "The Way of Kings")).toBe(true);
  });

  it("leaves the existing cache untouched if Goodreads is unreachable", async () => {
    await prisma.goodreadsTbrItem.deleteMany();
    await prisma.goodreadsTbrItem.create({ data: { title: "Still Here", author: "Someone" } });

    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(syncGoodreadsTbr("1993628")).rejects.toThrow();

    const items = await prisma.goodreadsTbrItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Still Here");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run goodreadsSync`
Expected: FAIL with "Cannot find module '@/lib/goodreadsSync'".

- [ ] **Step 3: Implement the Goodreads sync module**

```typescript
// src/lib/goodreadsSync.ts
import { XMLParser } from "fast-xml-parser";
import { prisma } from "@/lib/prisma";

export interface GoodreadsBook {
  title: string;
  author: string | null;
  isbn: string | null;
}

const SHELF = "to-read";
const MAX_PAGES = 100; // matches the audiobook-compare reference script's cap

const parser = new XMLParser({ ignoreAttributes: true });

function normalizeIsbn(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  const digits = s.replace(/[^0-9Xx]/g, "");
  return digits || null;
}

export async function fetchGoodreadsPage(userId: string, page: number): Promise<GoodreadsBook[]> {
  const url = new URL(`https://www.goodreads.com/review/list_rss/${userId}`);
  url.searchParams.set("shelf", SHELF);
  url.searchParams.set("per_page", "200");
  url.searchParams.set("page", String(page));

  const response = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Goodreads shelf page ${page}: HTTP ${response.status}`);
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = parser.parse(text);
  } catch {
    throw new Error(
      `Goodreads returned non-XML on page ${page} (first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  const rawItems = parsed?.rss?.channel?.item;
  if (!rawItems) return [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const books: GoodreadsBook[] = [];
  for (const item of items) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const author =
      typeof item.author_name === "string" && item.author_name.trim()
        ? item.author_name.trim()
        : null;
    const isbn = normalizeIsbn(item.isbn13) ?? normalizeIsbn(item.isbn);
    books.push({ title, author, isbn });
  }
  return books;
}

export async function fetchAllGoodreadsBooks(userId: string): Promise<GoodreadsBook[]> {
  const allBooks: GoodreadsBook[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const books = await fetchGoodreadsPage(userId, page);
    if (books.length === 0) break;
    allBooks.push(...books);
  }
  return allBooks;
}

// Full replace (not upsert-by-id) since Goodreads' RSS feed exposes no stable
// per-item id to key on, and a book removed from the shelf should disappear
// from the TBR gap view too — per the design spec.
export async function syncGoodreadsTbr(userId: string): Promise<{ synced: number }> {
  const books = await fetchAllGoodreadsBooks(userId);

  await prisma.$transaction([
    prisma.goodreadsTbrItem.deleteMany(),
    prisma.goodreadsTbrItem.createMany({
      data: books.map((book) => ({
        title: book.title,
        author: book.author,
        isbn: book.isbn,
      })),
    }),
  ]);

  return { synced: books.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run goodreadsSync`
Expected: PASS.

- [ ] **Step 5: Verify live against the real Goodreads shelf**

```bash
curl -s "https://www.goodreads.com/review/list_rss/1993628?shelf=to-read&per_page=5&page=1" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" \
  | head -c 1000
```

Expected: real XML content with `<item>` entries containing `<title>`/`<author_name>` for actual books on the "to-read" shelf (or an empty-but-valid `<channel>` if the shelf happens to be empty — either is a legitimate live-verification result, just confirm it's real XML, not an error page).

- [ ] **Step 6: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "feat: add Goodreads to-read shelf RSS client and TBR sync"
```

---

### Task 5: Sync API routes

**Files:**
- Create: `src/app/api/sync/abs/route.ts`
- Create: `src/app/api/sync/goodreads/route.ts`

- [ ] **Step 1: Write the ABS sync route**

```typescript
// src/app/api/sync/abs/route.ts
import { NextResponse } from "next/server";
import { syncAbsCache } from "@/lib/absSync";

export async function POST() {
  const absUrl = process.env.ABS_URL;
  const absToken = process.env.ABS_TOKEN;

  if (!absUrl || !absToken) {
    return NextResponse.json(
      { error: "Server misconfigured: ABS_URL/ABS_TOKEN not set" },
      { status: 500 },
    );
  }

  try {
    const result = await syncAbsCache(absUrl, absToken);
    return NextResponse.json({ success: true, synced: result.synced });
  } catch (error) {
    console.error("ABS sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ABS sync failed" },
      { status: 502 },
    );
  }
}
```

- [ ] **Step 2: Write the Goodreads sync route**

```typescript
// src/app/api/sync/goodreads/route.ts
import { NextResponse } from "next/server";
import { syncGoodreadsTbr } from "@/lib/goodreadsSync";

export async function POST() {
  const userId = process.env.GOODREADS_USER_ID;

  if (!userId) {
    return NextResponse.json(
      { error: "Server misconfigured: GOODREADS_USER_ID not set" },
      { status: 500 },
    );
  }

  try {
    const result = await syncGoodreadsTbr(userId);
    return NextResponse.json({ success: true, synced: result.synced });
  } catch (error) {
    console.error("Goodreads sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Goodreads sync failed" },
      { status: 502 },
    );
  }
}
```

Both routes deliberately catch and log rather than let the error propagate — per the design spec, a sync failure should leave the existing cache untouched and be surfaced as a normal JSON error response (for the manual refresh button in Task 7), not a 500 crash.

- [ ] **Step 3: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, then in another terminal:

```bash
curl -s -X POST http://localhost:3000/api/sync/abs -b "<paste your session cookie from devtools>"
curl -s -X POST http://localhost:3000/api/sync/goodreads -b "<paste your session cookie from devtools>"
```

(Both routes sit behind the existing auth middleware like every other route in this app — check `src/middleware.ts` first to confirm exactly which paths it guards and get a valid session cookie the same way prior phases did, e.g. by logging in via the browser and copying the session cookie from devtools, or by temporarily swapping `APP_PASSWORD_HASH` for a known test password per this repo's established local-verification pattern.)

Expected: both return `{"success":true,"synced":<N>}` with `N` matching real counts from your ABS libraries and Goodreads shelf. Confirm via `docker exec -i book-catalog-postgres-1 psql -U bookcatalog -d bookcatalog -c 'SELECT COUNT(*) FROM "AbsCacheItem";'` and the equivalent for `"GoodreadsTbrItem"` that rows actually landed. Stop the dev server via targeted PID kill afterward.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sync/abs/route.ts src/app/api/sync/goodreads/route.ts
git commit -m "feat: add ABS and Goodreads sync API routes"
```

---

### Task 6: Scheduled sync via node-cron

**Files:**
- Create: `src/instrumentation.ts`

- [ ] **Step 1: Write the instrumentation hook**

```typescript
// src/instrumentation.ts
export async function register() {
  // Only run in the actual Node.js server process — instrumentation.ts is
  // also loaded for the Edge runtime, where node-cron (and the sync modules'
  // use of Node's fs/net-backed fetch through Prisma) doesn't apply.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const cron = await import("node-cron");
  const { syncAbsCache } = await import("@/lib/absSync");
  const { syncGoodreadsTbr } = await import("@/lib/goodreadsSync");

  // Every 30 minutes — within the design spec's "every 30-60 minutes" range.
  cron.schedule("*/30 * * * *", async () => {
    const absUrl = process.env.ABS_URL;
    const absToken = process.env.ABS_TOKEN;
    if (!absUrl || !absToken) {
      console.error("Skipping scheduled ABS sync: ABS_URL/ABS_TOKEN not set");
      return;
    }
    try {
      const result = await syncAbsCache(absUrl, absToken);
      console.log(`Scheduled ABS sync: ${result.synced} items synced`);
    } catch (error) {
      console.error("Scheduled ABS sync failed:", error);
    }
  });

  cron.schedule("*/30 * * * *", async () => {
    const userId = process.env.GOODREADS_USER_ID;
    if (!userId) {
      console.error("Skipping scheduled Goodreads sync: GOODREADS_USER_ID not set");
      return;
    }
    try {
      const result = await syncGoodreadsTbr(userId);
      console.log(`Scheduled Goodreads sync: ${result.synced} items synced`);
    } catch (error) {
      console.error("Scheduled Goodreads sync failed:", error);
    }
  });

  console.log("Registered ABS and Goodreads sync cron jobs (every 30 minutes)");
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live that registration actually happens on server start**

```bash
npm run dev
```

Expected: the dev server's startup log includes `Registered ABS and Goodreads sync cron jobs (every 30 minutes)`. You do not need to wait 30 minutes to confirm the schedule fires — confirming the registration log line proves `register()` ran and `cron.schedule(...)` was called without throwing; the manual refresh route from Task 5 already proves the underlying sync functions work correctly. Stop the dev server via targeted PID kill afterward.

- [ ] **Step 4: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat: schedule ABS and Goodreads sync via node-cron in instrumentation.ts"
```

---

### Task 7: Manual "Refresh now" button

**Files:**
- Create: `src/components/RefreshSyncButton.tsx`

- [ ] **Step 1: Write the component**

```typescript
// src/components/RefreshSyncButton.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RefreshSyncButton() {
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setIsRefreshing(true);
    setError(null);

    try {
      const [absResponse, goodreadsResponse] = await Promise.all([
        fetch("/api/sync/abs", { method: "POST" }),
        fetch("/api/sync/goodreads", { method: "POST" }),
      ]);
      const absData = await absResponse.json();
      const goodreadsData = await goodreadsResponse.json();

      const errors: string[] = [];
      if (!absData.success) errors.push(`ABS: ${absData.error}`);
      if (!goodreadsData.success) errors.push(`Goodreads: ${goodreadsData.error}`);

      if (errors.length > 0) {
        setError(errors.join("; "));
      } else {
        router.refresh();
      }
    } catch {
      setError("Refresh failed — check your connection and try again.");
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="rounded border border-black px-3 py-2 text-sm disabled:opacity-50"
      >
        {isRefreshing ? "Refreshing..." : "Refresh now"}
      </button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/RefreshSyncButton.tsx
git commit -m "feat: add manual refresh-now button for ABS/Goodreads sync"
```

(This component gets wired into the home page in Task 8 — committing it standalone first keeps this task's diff reviewable on its own.)

---

### Task 8: Unified search — replace the home page

**Files:**
- Create: `src/lib/search.ts`
- Create: `src/lib/search.test.ts`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Write the failing tests for the merge logic**

```typescript
// src/lib/search.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog } from "@/lib/search";

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({ where: { book: { title: { startsWith: "Test Search" } } } });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Search" } } });
  await prisma.absCacheItem.deleteMany({ where: { title: { startsWith: "Test Search" } } });
});

describe("searchCatalog", () => {
  it("returns a merged result when the same book exists as a physical copy and an ABS ebook", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Search Mistborn",
        author: "Brandon Sanderson",
        copies: { create: { format: "PAPERBACK", publisher: "Tor", publishYear: 2010 } },
      },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "test-search-mistborn-ebook",
        title: "Test Search Mistborn",
        author: "Brandon Sanderson",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog("Mistborn");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Search Mistborn");
    expect(results[0].physicalCopies).toHaveLength(1);
    expect(results[0].hasEbook).toBe(true);
    expect(results[0].hasAudiobook).toBe(false);

    await prisma.book.delete({ where: { id: book.id } });
  });

  it("does not merge two unrelated titles into one result", async () => {
    await prisma.book.create({ data: { title: "Test Search Alpha" } });
    await prisma.absCacheItem.create({
      data: { absItemId: "test-search-beta", title: "Test Search Beta", mediaType: "EBOOK" },
    });

    const results = await searchCatalog("Test Search");

    expect(results.map((r) => r.title).sort()).toEqual(["Test Search Alpha", "Test Search Beta"]);
  });

  it("returns an empty array for a query matching nothing", async () => {
    const results = await searchCatalog("Test Search Nonexistent Zzzzz");
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run search`
Expected: FAIL with "Cannot find module '@/lib/search'".

- [ ] **Step 3: Implement the search merge logic**

```typescript
// src/lib/search.ts
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";
import type { Format } from "@prisma/client";

export interface SearchResultCopy {
  id: string;
  format: Format;
  publisher: string | null;
  publishYear: number | null;
}

export interface SearchResult {
  title: string;
  author: string | null;
  bookId: string | null;
  physicalCopies: SearchResultCopy[];
  hasEbook: boolean;
  hasAudiobook: boolean;
}

export async function searchCatalog(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const [books, absItems] = await Promise.all([
    prisma.book.findMany({
      where: {
        OR: [
          { title: { contains: trimmed, mode: "insensitive" } },
          { author: { contains: trimmed, mode: "insensitive" } },
          { isbn: { contains: trimmed, mode: "insensitive" } },
        ],
      },
      include: { copies: true },
    }),
    prisma.absCacheItem.findMany({
      where: {
        OR: [
          { title: { contains: trimmed, mode: "insensitive" } },
          { author: { contains: trimmed, mode: "insensitive" } },
          { isbn: { contains: trimmed, mode: "insensitive" } },
        ],
      },
    }),
  ]);

  const results: SearchResult[] = books.map((book) => ({
    title: book.title,
    author: book.author,
    bookId: book.id,
    physicalCopies: book.copies.map((copy) => ({
      id: copy.id,
      format: copy.format,
      publisher: copy.publisher,
      publishYear: copy.publishYear,
    })),
    hasEbook: false,
    hasAudiobook: false,
  }));

  for (const item of absItems) {
    const existing = results.find((r) => isTitleMatch(r.title, item.title));
    if (existing) {
      if (item.mediaType === "EBOOK") existing.hasEbook = true;
      if (item.mediaType === "AUDIOBOOK") existing.hasAudiobook = true;
    } else {
      results.push({
        title: item.title,
        author: item.author,
        bookId: null,
        physicalCopies: [],
        hasEbook: item.mediaType === "EBOOK",
        hasAudiobook: item.mediaType === "AUDIOBOOK",
      });
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run search`
Expected: PASS.

- [ ] **Step 5: Replace the home page with the unified search UI**

Read the current `src/app/page.tsx` first (it's a small placeholder from Phase 1 showing just a book count and a link to `/books` — confirm this before replacing it, since if it has grown other responsibilities since then this step should adapt rather than blindly overwrite).

```typescript
// src/app/page.tsx
import Link from "next/link";
import { searchCatalog } from "@/lib/search";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { RefreshSyncButton } from "@/components/RefreshSyncButton";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const results = query ? await searchCatalog(query) : [];

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Book Catalog</h1>
        <RefreshSyncButton />
      </div>

      <form action="/" method="get" className="mb-4">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
          className="w-full rounded border p-2"
        />
      </form>

      <div className="mb-4 flex gap-4 text-sm">
        <Link href="/books" className="underline">
          Manage physical books
        </Link>
        <Link href="/tbr" className="underline">
          TBR gap view
        </Link>
      </div>

      {query && results.length === 0 && <p className="text-gray-600">No matches found.</p>}

      {results.length > 0 && (
        <ul className="space-y-3">
          {results.map((result) => (
            <li key={result.bookId ?? result.title} className="rounded border p-3">
              <p className="font-medium">{result.title}</p>
              {result.author && <p className="text-sm text-gray-600">{result.author}</p>}
              <div className="mt-1 flex flex-wrap gap-2 text-sm">
                {result.physicalCopies.map((copy) => (
                  <span key={copy.id} className="rounded bg-gray-100 px-2 py-0.5">
                    Physical ({FORMAT_LABELS[copy.format]}
                    {copy.publisher ? `, ${copy.publisher}` : ""}
                    {copy.publishYear ? ` ${copy.publishYear}` : ""})
                  </span>
                ))}
                {result.hasEbook && (
                  <span className="rounded bg-gray-100 px-2 py-0.5">Ebook ✓</span>
                )}
                {result.hasAudiobook && (
                  <span className="rounded bg-gray-100 px-2 py-0.5">Audiobook ✓</span>
                )}
              </div>
              {result.bookId && (
                <Link
                  href={`/books/${result.bookId}`}
                  className="mt-1 inline-block text-sm underline"
                >
                  View details
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm underline">
          Log out
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 6: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, confirm the home page shows a search box instead of the old book-count placeholder. Search for a title that exists as both a physical book (add one via `/books/scan` or `/books/new` first if the catalog is empty) and confirm it renders correctly with a "View details" link. Search for something that matches nothing and confirm "No matches found." shows. Click "Refresh now" and confirm it either succeeds (if ABS/Goodreads env vars are set and reachable) or shows a clear inline error (if not) — either is fine, just confirm it doesn't crash the page. Stop the dev server via targeted PID kill.

- [ ] **Step 8: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts src/app/page.tsx
git commit -m "feat: replace home page with unified physical/ebook/audiobook search"
```

---

### Task 9: TBR gap view

**Files:**
- Create: `src/lib/tbrGap.ts`
- Create: `src/lib/tbrGap.test.ts`
- Create: `src/app/tbr/page.tsx`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/tbrGap.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getTbrGap } from "@/lib/tbrGap";

afterEach(async () => {
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
  await prisma.absCacheItem.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
});

describe("getTbrGap", () => {
  it("excludes a TBR item that matches an owned physical book", async () => {
    await prisma.book.create({ data: { title: "Test TBR Owned Book" } });
    await prisma.goodreadsTbrItem.create({ data: { title: "Test TBR Owned Book", author: "Someone" } });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Owned Book")).toBe(false);
  });

  it("excludes a TBR item that matches an ABS ebook/audiobook", async () => {
    await prisma.absCacheItem.create({
      data: { absItemId: "test-tbr-abs-1", title: "Test TBR Abs Book", mediaType: "AUDIOBOOK" },
    });
    await prisma.goodreadsTbrItem.create({ data: { title: "Test TBR Abs Book", author: "Someone" } });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Abs Book")).toBe(false);
  });

  it("includes a TBR item not owned in any form", async () => {
    await prisma.goodreadsTbrItem.create({ data: { title: "Test TBR Not Owned", author: "Someone" } });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Not Owned")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run tbrGap`
Expected: FAIL with "Cannot find module '@/lib/tbrGap'".

- [ ] **Step 3: Implement the gap logic**

```typescript
// src/lib/tbrGap.ts
import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";

export interface TbrGapItem {
  id: string;
  title: string;
  author: string | null;
}

export async function getTbrGap(): Promise<TbrGapItem[]> {
  const [tbrItems, books, absItems] = await Promise.all([
    prisma.goodreadsTbrItem.findMany(),
    prisma.book.findMany({ select: { title: true } }),
    prisma.absCacheItem.findMany({ select: { title: true } }),
  ]);

  const ownedTitles = [...books.map((b) => b.title), ...absItems.map((a) => a.title)];

  return tbrItems
    .filter((tbr) => !ownedTitles.some((owned) => isTitleMatch(tbr.title, owned)))
    .map((tbr) => ({ id: tbr.id, title: tbr.title, author: tbr.author }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run tbrGap`
Expected: PASS.

- [ ] **Step 5: Write the TBR page**

```typescript
// src/app/tbr/page.tsx
import Link from "next/link";
import { getTbrGap } from "@/lib/tbrGap";

export const dynamic = "force-dynamic";

export default async function TbrGapPage() {
  const gap = await getTbrGap();

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">TBR — Not Yet Owned</h1>
        <Link href="/" className="text-sm underline">
          Back to search
        </Link>
      </div>

      {gap.length === 0 ? (
        <p className="text-gray-600">
          Everything on your to-read shelf is already owned in some form.
        </p>
      ) : (
        <ul className="space-y-2">
          {gap.map((item) => (
            <li key={item.id} className="rounded border p-3">
              <p className="font-medium">{item.title}</p>
              {item.author && <p className="text-sm text-gray-600">{item.author}</p>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 6: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, navigate to `/tbr` directly and via the "TBR gap view" link on the home page. If Goodreads/ABS syncs have been run at least once (Task 5/8's live verification should have already populated real data), confirm the page shows a plausible subset of your real to-read shelf minus what's already owned. Stop the dev server via targeted PID kill.

- [ ] **Step 8: Commit**

```bash
git add src/lib/tbrGap.ts src/lib/tbrGap.test.ts src/app/tbr/page.tsx
git commit -m "feat: add TBR gap view page"
```

---

## Phase 4 capstone verification (after all 9 tasks)

```bash
npm test -- --run
npx tsc --noEmit
npx eslint .
npx next build
```

Confirm the build output shows `/`, `/tbr`, `/api/sync/abs`, and `/api/sync/goodreads` as dynamic (`ƒ`) routes (they all read live request data / hit external services or the DB on every request, so none should be statically prerendered).

Then, with real ABS/Goodreads env vars set and a real Postgres running:

1. Hit `/api/sync/abs` and `/api/sync/goodreads` once each (via the "Refresh now" button or curl) to populate real data.
2. Confirm the home-page search surfaces at least one book you know is in both your physical catalog and your ABS library, showing both "Physical" and "Ebook ✓"/"Audiobook ✓" tags merged into one result.
3. Confirm `/tbr` shows a real subset of your Goodreads to-read shelf, excluding anything you already own.
4. Confirm the "Refresh now" button works from the UI (not just curl) and that `router.refresh()` actually updates the visible search results/TBR list without a full page reload.

This phase should not be considered fully done until that live verification with real data has actually been run — none of the mocked-fetch unit tests substitute for confirming the real ABS/Goodreads integration and the fuzzy-matching threshold behave sensibly against the user's actual library.
