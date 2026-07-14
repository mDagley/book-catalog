# Search & Browse Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ownership-type (physical/ebook/audiobook) and physical-format filtering to the home page's unified search and the `/books` physical-catalog browse page, matching `docs/superpowers/specs/2026-07-13-search-filtering-design.md`.

**Architecture:** `src/lib/search.ts`'s `searchCatalog` changes from a single `query: string` parameter to an options object (`{ query, types, format }`), with the Prisma queries and merge logic adjusted to respect the new filters. Two small parser helpers (`parseFormatParam`, `parseTypesParam`) validate raw URL query-string values into typed options, used by both pages. Both pages stay plain server-rendered `<form method="get">` — no client-side JavaScript.

**Tech Stack:** Next.js App Router (Server Components), Prisma, Vitest.

---

### Task 1: Restructure `searchCatalog` with filtering + parser helpers

**Files:**
- Modify: `src/lib/search.ts`
- Modify: `src/lib/search.test.ts`

- [ ] **Step 1: Write the failing/updated tests**

Replace the entire contents of `src/lib/search.test.ts` with:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchCatalog, parseFormatParam, parseTypesParam } from "@/lib/search";

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
        absItemId: "search-test-mistborn-ebook",
        title: "Test Search Mistborn",
        author: "Brandon Sanderson",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog({ query: "Mistborn" });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Search Mistborn");
    expect(results[0].physicalCopies).toHaveLength(1);
    expect(results[0].hasEbook).toBe(true);
    expect(results[0].hasAudiobook).toBe(false);

    await prisma.physicalCopy.deleteMany({ where: { bookId: book.id } });
    await prisma.book.delete({ where: { id: book.id } });
  });

  it("does not merge two unrelated titles into one result", async () => {
    await prisma.book.create({ data: { title: "Test Search Alpha" } });
    await prisma.absCacheItem.create({
      data: { absItemId: "search-test-beta", title: "Test Search Beta", mediaType: "EBOOK" },
    });

    const results = await searchCatalog({ query: "Test Search" });

    expect(results.map((r) => r.title).sort()).toEqual(["Test Search Alpha", "Test Search Beta"]);
  });

  it("attaches the ebook badge to the best-scoring title match, not just the first match above threshold", async () => {
    const weakBook = await prisma.book.create({
      data: { title: "Test Search Mist", author: "Brandon Sanderson" },
    });
    const exactBook = await prisma.book.create({
      data: { title: "Test Search Mistborn: The Final Empire", author: "Brandon Sanderson" },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-mistborn-best-match-ebook",
        title: "Test Search Mistborn: The Final Empire",
        author: "Brandon Sanderson",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog({ query: "Test Search" });

    const weakResult = results.find((r) => r.title === "Test Search Mist");
    const exactResult = results.find((r) => r.title === "Test Search Mistborn: The Final Empire");

    expect(exactResult?.hasEbook).toBe(true);
    expect(weakResult?.hasEbook).toBe(false);

    await prisma.book.delete({ where: { id: weakBook.id } });
    await prisma.book.delete({ where: { id: exactBook.id } });
  });

  it("returns an empty array for a query matching nothing", async () => {
    const results = await searchCatalog({ query: "Test Search Nonexistent Zzzzz" });
    expect(results).toEqual([]);
  });

  it("matches a stored normalized ISBN when searching with a hyphenated ISBN", async () => {
    await prisma.book.create({
      data: { title: "Test Search Isbn Book", isbn: "9780765326355" },
    });

    const results = await searchCatalog({ query: "978-0-7653-2635-5" });

    expect(results.map((r) => r.title)).toContain("Test Search Isbn Book");
  });

  it("does not match unrelated books via the ISBN clause when the query has no digits", async () => {
    await prisma.book.create({ data: { title: "Test Search Unrelated Alpha" } });
    await prisma.book.create({ data: { title: "Test Search Unrelated Beta" } });

    const results = await searchCatalog({ query: "Nonexistent Query With No Digits At All" });

    expect(results).toEqual([]);
  });

  it("returns an empty array when there is no query and no filters", async () => {
    const results = await searchCatalog({});
    expect(results).toEqual([]);
  });

  it("supports standalone browse by ownership type with no query text", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Physical Only Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-ebook-only",
        title: "Test Search Ebook Only Book",
        mediaType: "EBOOK",
      },
    });

    const ebookResults = await searchCatalog({ types: ["ebook"] });
    expect(ebookResults.map((r) => r.title)).toContain("Test Search Ebook Only Book");
    expect(ebookResults.map((r) => r.title)).not.toContain("Test Search Physical Only Book");

    const physicalResults = await searchCatalog({ types: ["physical"] });
    expect(physicalResults.map((r) => r.title)).toContain("Test Search Physical Only Book");
    expect(physicalResults.map((r) => r.title)).not.toContain("Test Search Ebook Only Book");
  });

  it("excludes audiobook-only results when types omits audiobook", async () => {
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-audiobook-only",
        title: "Test Search Audiobook Only Book",
        mediaType: "AUDIOBOOK",
      },
    });

    const results = await searchCatalog({ types: ["ebook"] });

    expect(results.map((r) => r.title)).not.toContain("Test Search Audiobook Only Book");
  });

  it("excludes a book with zero physical copies from the physical type, even with no format set", async () => {
    // Reachable in practice: deleteCopyData (src/lib/copies.ts) never cascades
    // to delete the parent Book, so a copyless Book row is a real state.
    await prisma.book.create({ data: { title: "Test Search Copyless Book" } });

    const results = await searchCatalog({ types: ["physical"] });

    expect(results.map((r) => r.title)).not.toContain("Test Search Copyless Book");
  });

  it("narrows both inclusion and displayed copies when a format filter is active", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Search Multi Format Book",
        copies: {
          create: [{ format: "HARDCOVER" }, { format: "PAPERBACK" }],
        },
      },
    });

    const results = await searchCatalog({ types: ["physical"], format: "PAPERBACK" });

    const match = results.find((r) => r.title === "Test Search Multi Format Book");
    expect(match).toBeDefined();
    expect(match?.physicalCopies).toHaveLength(1);
    expect(match?.physicalCopies[0].format).toBe("PAPERBACK");

    await prisma.physicalCopy.deleteMany({ where: { bookId: book.id } });
    await prisma.book.delete({ where: { id: book.id } });
  });

  it("excludes a book with no copy in the requested format", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Search Hardcover Only Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    const results = await searchCatalog({ types: ["physical"], format: "PAPERBACK" });

    expect(results.map((r) => r.title)).not.toContain("Test Search Hardcover Only Book");

    await prisma.physicalCopy.deleteMany({ where: { bookId: book.id } });
    await prisma.book.delete({ where: { id: book.id } });
  });

  it("combines a text query with a type filter", async () => {
    await prisma.book.create({
      data: {
        title: "Test Search Combo Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.absCacheItem.create({
      data: {
        absItemId: "search-test-combo-ebook",
        title: "Test Search Combo Ebook",
        mediaType: "EBOOK",
      },
    });

    const results = await searchCatalog({ query: "Test Search Combo", types: ["physical"] });

    expect(results.map((r) => r.title)).toEqual(["Test Search Combo Book"]);
  });
});

describe("parseFormatParam", () => {
  it("returns undefined for an undefined or empty value", () => {
    expect(parseFormatParam(undefined)).toBeUndefined();
    expect(parseFormatParam("")).toBeUndefined();
  });

  it("returns the value for a valid Format", () => {
    expect(parseFormatParam("PAPERBACK")).toBe("PAPERBACK");
  });

  it("returns undefined for an unrecognized value", () => {
    expect(parseFormatParam("NOT_A_FORMAT")).toBeUndefined();
  });
});

describe("parseTypesParam", () => {
  it("returns undefined for an undefined or empty value", () => {
    expect(parseTypesParam(undefined)).toBeUndefined();
    expect(parseTypesParam("")).toBeUndefined();
  });

  it("parses a single value", () => {
    expect(parseTypesParam("ebook")).toEqual(["ebook"]);
  });

  it("parses a comma-separated value (manually-typed/bookmarked URL)", () => {
    expect(parseTypesParam("ebook,audiobook")).toEqual(["ebook", "audiobook"]);
  });

  it("parses an array value (repeated same-name checkboxes)", () => {
    expect(parseTypesParam(["ebook", "physical"])).toEqual(["ebook", "physical"]);
  });

  it("drops unrecognized tokens and keeps valid ones", () => {
    expect(parseTypesParam("ebook,bogus,physical")).toEqual(["ebook", "physical"]);
  });

  it("returns undefined when every token is unrecognized", () => {
    expect(parseTypesParam("bogus,alsobogus")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --run search`
Expected: FAIL — `parseFormatParam`/`parseTypesParam` don't exist yet, and `searchCatalog` still takes a positional string, not an options object (existing tests calling `searchCatalog({ query: "..." })` will fail type-check/at runtime since the current function does `query.trim()` on an object).

- [ ] **Step 3: Implement the restructured `search.ts`**

Replace the entire contents of `src/lib/search.ts` with:

```typescript
import { prisma } from "@/lib/prisma";
import { titleMatchScore, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";
import { normalizeIsbn } from "@/lib/books";
import type { Format, MediaType } from "@prisma/client";

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

export type OwnershipType = "physical" | "ebook" | "audiobook";

export interface SearchOptions {
  query?: string;
  types?: OwnershipType[];
  format?: Format;
}

const VALID_FORMATS: readonly string[] = ["HARDCOVER", "PAPERBACK", "MASS_MARKET", "OTHER"];
const VALID_TYPES: readonly string[] = ["physical", "ebook", "audiobook"];

export function parseFormatParam(value: string | undefined): Format | undefined {
  if (!value) return undefined;
  return VALID_FORMATS.includes(value) ? (value as Format) : undefined;
}

export function parseTypesParam(
  value: string | string[] | undefined,
): OwnershipType[] | undefined {
  if (!value) return undefined;
  const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",");
  const parsed = tokens
    .map((t) => t.trim())
    .filter((t): t is OwnershipType => VALID_TYPES.includes(t));
  return parsed.length > 0 ? parsed : undefined;
}

export async function searchCatalog(options: SearchOptions): Promise<SearchResult[]> {
  const trimmed = options.query?.trim() ?? "";
  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;

  if (!trimmed && !types && !format) return [];

  const includePhysical = !types || types.includes("physical");
  const includeEbook = !types || types.includes("ebook");
  const includeAudiobook = !types || types.includes("audiobook");

  // Only require an existing physical copy when the user actively asked for
  // a physical-ownership view (an explicit "physical" type filter, or a
  // format filter) -- NOT for a fully unfiltered/default search. A copyless
  // Book row is a real, reachable state (see the zero-copy note above), and
  // for a plain unfiltered query it should still surface bare (no physical
  // badge, since its copies array is empty) exactly as it did before this
  // feature existed -- it's only wrong to include it under an EXPLICIT
  // physical-ownership filter, which is a stronger claim ("you own this
  // physically") that a copyless book can't back up.
  const explicitPhysicalFilterActive =
    format !== undefined || (types !== undefined && types.includes("physical"));

  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed);
  const normalizedIsbnQuery = trimmed && looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";

  const mediaTypesToFetch: MediaType[] = [];
  if (includeEbook) mediaTypesToFetch.push("EBOOK");
  if (includeAudiobook) mediaTypesToFetch.push("AUDIOBOOK");

  const [books, absItems] = await Promise.all([
    includePhysical
      ? prisma.book.findMany({
          where: {
            ...(trimmed
              ? {
                  OR: [
                    { title: { contains: trimmed, mode: "insensitive" as const } },
                    { author: { contains: trimmed, mode: "insensitive" as const } },
                    ...(normalizedIsbnQuery
                      ? [
                          {
                            isbn: {
                              contains: normalizedIsbnQuery,
                              mode: "insensitive" as const,
                            },
                          },
                        ]
                      : []),
                  ],
                }
              : {}),
            ...(explicitPhysicalFilterActive
              ? { copies: format ? { some: { format } } : { some: {} } }
              : {}),
          },
          include: {
            copies: { where: format ? { format } : undefined },
          },
          orderBy: { id: "asc" },
        })
      : Promise.resolve([]),
    mediaTypesToFetch.length > 0
      ? prisma.absCacheItem.findMany({
          where: {
            ...(trimmed
              ? {
                  OR: [
                    { title: { contains: trimmed, mode: "insensitive" as const } },
                    { author: { contains: trimmed, mode: "insensitive" as const } },
                    ...(normalizedIsbnQuery
                      ? [
                          {
                            isbn: {
                              contains: normalizedIsbnQuery,
                              mode: "insensitive" as const,
                            },
                          },
                        ]
                      : []),
                  ],
                }
              : {}),
            mediaType: { in: mediaTypesToFetch },
          },
        })
      : Promise.resolve([]),
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
    let bestMatch: SearchResult | null = null;
    let bestScore = -1;
    for (const result of results) {
      const score = titleMatchScore(result.title, item.title);
      if (score >= DEFAULT_MATCH_THRESHOLD && score > bestScore) {
        bestMatch = result;
        bestScore = score;
      }
    }
    if (bestMatch) {
      if (item.mediaType === "EBOOK") bestMatch.hasEbook = true;
      if (item.mediaType === "AUDIOBOOK") bestMatch.hasAudiobook = true;
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

Note on `parseTypesParam`'s dual input handling: Next.js's App Router `searchParams` gives a single `string` for one occurrence of a query param and a `string[]` when the same param name appears multiple times in the URL. Submitting several checkboxes all named `types` (Task 2) produces the multi-value form (`?types=physical&types=ebook`); a hand-typed or bookmarked URL might use the comma-separated form (`?types=physical,ebook`) instead. `parseTypesParam` accepts and normalizes both.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run search`
Expected: PASS (all `searchCatalog`, `parseFormatParam`, and `parseTypesParam` tests).

- [ ] **Step 5: Run the full suite and type-check**

```bash
npm test -- --run
npx tsc --noEmit
```

Expected: all tests pass (note: per this repo's known pre-existing issue, running the full suite may reset `GoodreadsTbrItem` to near-empty as a side effect of an unrelated test in `goodreadsSync.test.ts` — not something to fix here), no type errors. Note `src/app/page.tsx` and `src/app/books/page.tsx` will fail to type-check at this point since they still call the old `searchCatalog(query: string)` signature — that's expected and fixed in Tasks 2 and 3.

- [ ] **Step 6: Commit**

```bash
git add src/lib/search.ts src/lib/search.test.ts
git commit -m "feat: add ownership-type and format filtering to searchCatalog"
```

---

### Task 2: Wire filtering into the home page

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Replace the home page**

Replace the entire contents of `src/app/page.tsx` with:

```typescript
import Link from "next/link";
import { searchCatalog, parseFormatParam, parseTypesParam, type OwnershipType } from "@/lib/search";
import { FORMAT_OPTIONS, FORMAT_LABELS } from "@/components/CopyFormFields";
import { RefreshSyncButton } from "@/components/RefreshSyncButton";

export const dynamic = "force-dynamic";

const OWNERSHIP_TYPE_OPTIONS: { value: OwnershipType; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "ebook", label: "Ebook" },
  { value: "audiobook", label: "Audiobook" },
];

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; types?: string | string[]; format?: string }>;
}) {
  const { q, types: typesParam, format: formatParam } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);

  const results = await searchCatalog({ query, types, format });
  const hasActiveFilters = Boolean(query || types || format);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Book Catalog</h1>
        <RefreshSyncButton />
      </div>

      <form action="/" method="get" className="mb-4 space-y-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
          className="w-full rounded border p-2"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {OWNERSHIP_TYPE_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-1">
              <input
                type="checkbox"
                name="types"
                value={opt.value}
                defaultChecked={types?.includes(opt.value) ?? false}
              />
              {opt.label}
            </label>
          ))}
          <select
            name="format"
            defaultValue={format ?? ""}
            className="rounded border p-1"
            aria-label="Filter by physical format"
          >
            <option value="">Any format</option>
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-black px-3 py-1 text-white">
            Search
          </button>
        </div>
      </form>

      <div className="mb-4 flex gap-4 text-sm">
        <Link href="/books" className="underline">
          Manage physical books
        </Link>
        <Link href="/tbr" className="underline">
          TBR gap view
        </Link>
      </div>

      {hasActiveFilters && results.length === 0 && (
        <p className="text-gray-600">No matches found.</p>
      )}

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

Note: a "Search" submit button is added — the previous single-text-input form relied on implicit Enter-to-submit, which doesn't apply to checkboxes/selects. This is a required addition (not scope creep) for the new controls to be usable without JavaScript.

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors (this resolves the `page.tsx`-related error from Task 1's Step 5).

- [ ] **Step 3: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in (see this repo's established hash-swap pattern in `.env` if needed for local login). On the home page:
- Confirm the three checkboxes and format dropdown render next to the search box.
- Search for a known title with no filters — confirm unchanged behavior from before this task.
- Check only "Ebook", submit with no text — confirm it lists ebook-owned titles only (standalone browse).
- Check "Physical" and pick a format, submit with no text — confirm only physically-owned books in that format appear, and if a matching book also has copies in other formats, confirm only the selected format's copy shows.
- Uncheck everything and clear the text box, submit — confirm the page returns to today's blank/placeholder state (no results, no "No matches found" message).

Stop the dev server via targeted PID kill afterward.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: add ownership-type and format filter controls to the home page"
```

---

### Task 3: Add format filtering to the `/books` page

**Files:**
- Modify: `src/app/books/page.tsx`

- [ ] **Step 1: Replace the books page**

Replace the entire contents of `src/app/books/page.tsx` with:

```typescript
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { parseFormatParam } from "@/lib/search";
import { FORMAT_OPTIONS } from "@/components/CopyFormFields";

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; format?: string }>;
}) {
  const { q, format: formatParam } = await searchParams;
  const query = q?.trim() || "";
  const format = parseFormatParam(formatParam);

  const books = await prisma.book.findMany({
    where: {
      ...(query
        ? {
            OR: [
              { title: { contains: query, mode: "insensitive" } },
              { author: { contains: query, mode: "insensitive" } },
              { isbn: { contains: query, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(format ? { copies: { some: { format } } } : {}),
    },
    include: { copies: true },
    orderBy: { title: "asc" },
  });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Physical Books</h1>
        <Link href="/books/scan" className="rounded bg-black px-3 py-2 text-sm text-white">
          + Add a book
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4 space-y-2">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
          className="w-full rounded border p-2"
        />
        <div className="flex items-center gap-2 text-sm">
          <select
            name="format"
            defaultValue={format ?? ""}
            className="rounded border p-1"
            aria-label="Filter by physical format"
          >
            <option value="">Any format</option>
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-black px-3 py-1 text-white">
            Search
          </button>
        </div>
      </form>

      {books.length === 0 ? (
        <p className="text-gray-600">No books found.</p>
      ) : (
        <ul className="space-y-3">
          {books.map((book) => (
            <li key={book.id} className="rounded border p-3">
              <Link href={`/books/${book.id}`} className="font-medium hover:underline">
                {book.title}
              </Link>
              {book.author && <p className="text-sm text-gray-600">{book.author}</p>}
              <p className="text-sm text-gray-500">
                {book.copies.length} {book.copies.length === 1 ? "copy" : "copies"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

Behavior note: with no query and no format, this is unchanged from today (shows every book) — `/books` was never a placeholder-until-you-type page like the home page, so this task doesn't add a "no active filter → blank" gate.

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

With the dev server running (from Task 2's Step 3, or start it again the same way): go to `/books`, pick a format from the dropdown with no text query, confirm only books with a copy in that format appear. Combine with a text query and confirm both narrow together. Stop the dev server via targeted PID kill afterward.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/page.tsx
git commit -m "feat: add physical-format filter to the /books browse page"
```

---

## Capstone verification (after all 3 tasks)

```bash
npm test -- --run
npx tsc --noEmit
npx eslint .
npx next build
```

Then, with real data in Postgres (physical books, and if available, real synced `AbsCacheItem` data):

1. On the home page, filter to ebook-only with no text and confirm real ebook-owned titles appear, nothing else.
2. On the home page, filter to physical + a specific format and confirm the right subset, with only matching-format copies displayed on multi-format books.
3. On `/books`, filter by format and confirm the right subset of the real physical catalog appears.
4. Delete a book's only copy (via the existing UI) and confirm it no longer appears under the home page's physical filter or on `/books` at all — this exercises the zero-copy exclusion rule against real data, not just the unit test's synthetic case.
5. Confirm clearing all filters and the text box on both pages returns to each page's original (pre-this-plan) behavior.

This plan should not be considered done until this live verification has actually been run.
