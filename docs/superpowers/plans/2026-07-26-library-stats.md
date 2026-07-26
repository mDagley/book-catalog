# Library Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stats` page giving an at-a-glance picture of the library — totals, reading progress, physical shelf breakdown, top authors, and TBR numbers.

**Architecture:** One `src/lib/stats.ts` module running every aggregate in a single `Promise.all` (measured 38ms for all 11 queries at 2000 books), consumed by a server-rendered `/stats` page. No caching, no persisted table. All visualizations are single-hue HTML bars — the theme's palette cannot support multi-series colour (measured ΔE 0.2 under deuteranopia), so length carries the data and colour carries nothing.

**Tech Stack:** TypeScript, Prisma (Postgres), Next.js 16 App Router server components, Tailwind v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-26-library-stats-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/stats.ts` (create) | All aggregate queries + bucket normalization. One exported `getLibraryStats()`. |
| `src/lib/stats.test.ts` (create) | Real-DB tests for every counting rule. |
| `src/components/StatTile.tsx` (create) | One headline number + label. |
| `src/components/StatBarList.tsx` (create) | A labelled single-hue horizontal bar list. Used by all five distributions. |
| `src/app/stats/page.tsx` (create) | The page: composes tiles + bar lists. |
| `src/app/page.tsx` (modify) | Add the `/stats` link to the existing nav row. |

## Shared types (defined in Task 1, used by every later task — do not redefine)

```ts
export interface CountBucket {
  label: string;
  count: number;
}

export interface LibraryStats {
  totals: {
    books: number;
    copies: number;
    physicalBooks: number;
    ebookBooks: number;
    audiobookBooks: number;
    multiFormatBooks: number;
  };
  readStatus: CountBucket[];
  ratings: CountBucket[];
  formats: CountBucket[];
  topPublishers: CountBucket[];
  decades: CountBucket[];
  publishYearUnknown: number;
  topAuthors: CountBucket[];
  tbr: { total: number; owned: number; gap: number };
}
```

## Two gotchas verified up front (do not rediscover these)

1. **`$queryRaw` with `COUNT(*)` returns a JavaScript `bigint`**, which breaks arithmetic and serialization out of a server component. Confirmed empirically. Always cast: `COUNT(*)::int`.
2. **Prisma `groupBy` only returns buckets that exist.** If no book is rated 3, there is no `rating: 3` row. Every distribution must be normalized into its full, fixed set of buckets (with zeros) before returning — otherwise the UI silently omits categories.

---

### Task 1: `getLibraryStats` — totals and ownership

**Files:**
- Create: `src/lib/stats.ts`
- Test: `src/lib/stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getLibraryStats } from "@/lib/stats";

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({ where: { book: { title: { startsWith: "Test Stats" } } } });
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test Stats" } } } });
  await prisma.audiobookCopy.deleteMany({ where: { book: { title: { startsWith: "Test Stats" } } } });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Stats" } } });
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test Stats" } } });
});

describe("getLibraryStats totals", () => {
  it("counts books and copies separately when one book has several physical copies", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Multi Copy Book",
        copies: { create: [{ format: "PAPERBACK" }, { format: "HARDCOVER" }] },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.totals.books).toBe(1);
    expect(stats.totals.copies).toBe(2);
    expect(stats.totals.physicalBooks).toBe(1);
  });

  it("counts a book owned in several formats once per format and once as multi-format", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Multi Format Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-stats-ebook-1" } },
        copies: { create: { format: "PAPERBACK" } },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.totals.books).toBe(1);
    expect(stats.totals.physicalBooks).toBe(1);
    expect(stats.totals.ebookBooks).toBe(1);
    expect(stats.totals.audiobookBooks).toBe(0);
    expect(stats.totals.multiFormatBooks).toBe(1);
  });

  it("does not count a single-format book as multi-format", async () => {
    await prisma.book.create({
      data: { title: "Test Stats Single Format Book", copies: { create: { format: "PAPERBACK" } } },
    });

    const stats = await getLibraryStats();

    expect(stats.totals.multiFormatBooks).toBe(0);
  });

  it("returns zeroes for an empty library without throwing", async () => {
    const stats = await getLibraryStats();

    expect(stats.totals.books).toBe(0);
    expect(stats.totals.copies).toBe(0);
    expect(stats.totals.multiFormatBooks).toBe(0);
  });
});
```

**Important:** these tests assert absolute counts, so they only hold when the test database contains nothing else. The isolated test DB is empty between runs (every suite cleans up after itself), and `vitest.config.ts` sets `fileParallelism: false`. If you find another suite leaving rows behind, fix that suite's cleanup rather than weakening these assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- stats.test.ts`
Expected: FAIL — cannot resolve `@/lib/stats`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/stats.ts`:

```ts
import { prisma } from "@/lib/prisma";

export interface CountBucket {
  label: string;
  count: number;
}

export interface LibraryStats {
  totals: {
    books: number;
    copies: number;
    physicalBooks: number;
    ebookBooks: number;
    audiobookBooks: number;
    multiFormatBooks: number;
  };
  readStatus: CountBucket[];
  ratings: CountBucket[];
  formats: CountBucket[];
  topPublishers: CountBucket[];
  decades: CountBucket[];
  publishYearUnknown: number;
  topAuthors: CountBucket[];
  tbr: { total: number; owned: number; gap: number };
}

// Every figure here is a COUNT or GROUP BY executed inside Postgres --
// measured at 38ms for the whole batch against 2000 books, which is why this
// page has no cache and no persisted stats table. See
// docs/superpowers/specs/2026-07-26-library-stats-design.md for why that
// deliberately differs from the TBR gap's persisted-column approach: the
// preference is against expensive RECOMPUTATION (fuzzy matching in app
// code), not against computation.
export async function getLibraryStats(): Promise<LibraryStats> {
  const [
    books,
    physicalCopies,
    ebookCopies,
    audiobookCopies,
    physicalBooks,
    ebookBooks,
    audiobookBooks,
    multiFormatRows,
  ] = await Promise.all([
    prisma.book.count(),
    prisma.physicalCopy.count(),
    prisma.ebookCopy.count(),
    prisma.audiobookCopy.count(),
    prisma.book.count({ where: { copies: { some: {} } } }),
    prisma.book.count({ where: { hasEbook: true } }),
    prisma.book.count({ where: { hasAudiobook: true } }),
    // Counts a book as multi-format when at least two of the three ownership
    // signals are present. Done in SQL rather than by pulling every book into
    // memory -- COUNT(*)::int (not bare COUNT(*)) because Postgres returns
    // bigint for the latter, which breaks arithmetic and serialization.
    prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM "Book" b
      WHERE (
        (CASE WHEN b."hasEbook" THEN 1 ELSE 0 END) +
        (CASE WHEN b."hasAudiobook" THEN 1 ELSE 0 END) +
        (CASE WHEN EXISTS (SELECT 1 FROM "PhysicalCopy" p WHERE p."bookId" = b.id) THEN 1 ELSE 0 END)
      ) >= 2
    `,
  ]);

  return {
    totals: {
      books,
      copies: physicalCopies + ebookCopies + audiobookCopies,
      physicalBooks,
      ebookBooks,
      audiobookBooks,
      multiFormatBooks: multiFormatRows[0]?.count ?? 0,
    },
    readStatus: [],
    ratings: [],
    formats: [],
    topPublishers: [],
    decades: [],
    publishYearUnknown: 0,
    topAuthors: [],
    tbr: { total: 0, owned: 0, gap: 0 },
  };
}
```

The empty arrays are filled in by Tasks 2–4; the interface is complete from the start so later tasks only add queries, never change the shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- stats.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts
git commit -m "feat: add getLibraryStats totals and ownership counts"
```

---

### Task 2: Reading — read status and ratings

**Files:**
- Modify: `src/lib/stats.ts`
- Test: `src/lib/stats.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("getLibraryStats reading", () => {
  it("reports a null readStatus as its own bucket, not as to-read", async () => {
    await prisma.book.create({ data: { title: "Test Stats No Status Book" } });
    await prisma.book.create({ data: { title: "Test Stats To Read Book", readStatus: "TO_READ" } });

    const stats = await getLibraryStats();
    const byLabel = Object.fromEntries(stats.readStatus.map((b) => [b.label, b.count]));

    expect(byLabel["No status"]).toBe(1);
    expect(byLabel["To read"]).toBe(1);
  });

  it("always returns all four read-status buckets, including empty ones", async () => {
    await prisma.book.create({ data: { title: "Test Stats Only Read Book", readStatus: "READ" } });

    const stats = await getLibraryStats();

    expect(stats.readStatus.map((b) => b.label)).toEqual([
      "Read",
      "Reading",
      "To read",
      "No status",
    ]);
    expect(stats.readStatus.find((b) => b.label === "Reading")!.count).toBe(0);
  });

  it("always returns all six rating buckets and counts unrated separately", async () => {
    await prisma.book.create({ data: { title: "Test Stats Rated Five", rating: 5 } });
    await prisma.book.create({ data: { title: "Test Stats Unrated Book" } });

    const stats = await getLibraryStats();

    expect(stats.ratings.map((b) => b.label)).toEqual([
      "5 stars",
      "4 stars",
      "3 stars",
      "2 stars",
      "1 star",
      "Unrated",
    ]);
    expect(stats.ratings.find((b) => b.label === "5 stars")!.count).toBe(1);
    expect(stats.ratings.find((b) => b.label === "Unrated")!.count).toBe(1);
    expect(stats.ratings.find((b) => b.label === "3 stars")!.count).toBe(0);
  });

  it("read-status buckets sum to the total book count", async () => {
    await prisma.book.create({ data: { title: "Test Stats Sum A", readStatus: "READ" } });
    await prisma.book.create({ data: { title: "Test Stats Sum B", readStatus: "READING" } });
    await prisma.book.create({ data: { title: "Test Stats Sum C" } });

    const stats = await getLibraryStats();

    expect(stats.readStatus.reduce((n, b) => n + b.count, 0)).toBe(stats.totals.books);
    expect(stats.ratings.reduce((n, b) => n + b.count, 0)).toBe(stats.totals.books);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- stats.test.ts`
Expected: FAIL — `readStatus` and `ratings` are still `[]`.

- [ ] **Step 3: Implement**

Add above `getLibraryStats` in `src/lib/stats.ts`:

```ts
import type { ReadStatus } from "@prisma/client";

// groupBy only returns buckets that actually have rows, so every
// distribution is projected onto a fixed, ordered bucket list. Without this
// a category with zero books silently vanishes from the page instead of
// showing an empty bar -- and "no books are currently being read" is
// information worth rendering.
const READ_STATUS_BUCKETS: { label: string; value: ReadStatus | null }[] = [
  { label: "Read", value: "READ" },
  { label: "Reading", value: "READING" },
  { label: "To read", value: "TO_READ" },
  // A book never touched by a Goodreads shelf sync has no status at all.
  // That is genuinely different from "to read" and is shown as its own
  // bucket rather than folded in.
  { label: "No status", value: null },
];

const RATING_BUCKETS: { label: string; value: number | null }[] = [
  { label: "5 stars", value: 5 },
  { label: "4 stars", value: 4 },
  { label: "3 stars", value: 3 },
  { label: "2 stars", value: 2 },
  { label: "1 star", value: 1 },
  { label: "Unrated", value: null },
];
```

Add these two queries to the `Promise.all` (append to the destructuring array and the call, keeping order aligned):

```ts
    prisma.book.groupBy({ by: ["readStatus"], _count: { _all: true } }),
    prisma.book.groupBy({ by: ["rating"], _count: { _all: true } }),
```

Destructure them as `readStatusGroups` and `ratingGroups`, then build the buckets:

```ts
  const readStatus = READ_STATUS_BUCKETS.map(({ label, value }) => ({
    label,
    count: readStatusGroups.find((g) => g.readStatus === value)?._count._all ?? 0,
  }));

  const ratings = RATING_BUCKETS.map(({ label, value }) => ({
    label,
    count: ratingGroups.find((g) => g.rating === value)?._count._all ?? 0,
  }));
```

Return `readStatus` and `ratings` instead of the empty arrays.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- stats.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts
git commit -m "feat: add read status and rating distributions to library stats"
```

---

### Task 3: Physical shelf — formats, publishers, decades

**Files:**
- Modify: `src/lib/stats.ts`
- Test: `src/lib/stats.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("getLibraryStats physical shelf", () => {
  it("counts formats per copy, not per book, and returns all four buckets", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Format Book",
        copies: { create: [{ format: "PAPERBACK" }, { format: "PAPERBACK" }] },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.formats.map((b) => b.label)).toEqual([
      "Hardcover",
      "Paperback",
      "Mass market",
      "Other",
    ]);
    expect(stats.formats.find((b) => b.label === "Paperback")!.count).toBe(2);
    expect(stats.formats.find((b) => b.label === "Hardcover")!.count).toBe(0);
  });

  it("format buckets sum to the total physical copy count", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Format Sum Book",
        copies: { create: [{ format: "HARDCOVER" }, { format: "OTHER" }] },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.formats.reduce((n, b) => n + b.count, 0)).toBe(2);
  });

  it("buckets publish years by decade and reports copies with no year separately", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Decade Book",
        copies: {
          create: [
            { format: "PAPERBACK", publishYear: 1998 },
            { format: "PAPERBACK", publishYear: 1991 },
            { format: "PAPERBACK", publishYear: 2003 },
            { format: "PAPERBACK" },
          ],
        },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.decades).toEqual([
      { label: "1990s", count: 2 },
      { label: "2000s", count: 1 },
    ]);
    expect(stats.publishYearUnknown).toBe(1);
  });

  it("ranks publishers by copy count, most first", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Publisher Book",
        copies: {
          create: [
            { format: "PAPERBACK", publisher: "Test Stats Tor" },
            { format: "PAPERBACK", publisher: "Test Stats Tor" },
            { format: "PAPERBACK", publisher: "Test Stats Gollancz" },
          ],
        },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.topPublishers[0]).toEqual({ label: "Test Stats Tor", count: 2 });
    expect(stats.topPublishers[1]).toEqual({ label: "Test Stats Gollancz", count: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- stats.test.ts`

- [ ] **Step 3: Implement**

Add the bucket list near the others:

```ts
import type { Format } from "@prisma/client";

const FORMAT_BUCKETS: { label: string; value: Format }[] = [
  { label: "Hardcover", value: "HARDCOVER" },
  { label: "Paperback", value: "PAPERBACK" },
  { label: "Mass market", value: "MASS_MARKET" },
  { label: "Other", value: "OTHER" },
];

// How many publishers/authors the ranked lists show. Ten keeps the lists
// readable; the visualization guidance treats more than ~7 colour-coded
// classes as a table, but these are single-hue ranked bars where length
// carries the data, so a longer list stays legible.
const TOP_N = 10;
```

Add to the `Promise.all`:

```ts
    prisma.physicalCopy.groupBy({ by: ["format"], _count: { _all: true } }),
    prisma.physicalCopy.groupBy({
      by: ["publisher"],
      where: { publisher: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { publisher: "desc" } },
      take: TOP_N,
    }),
    // Decade bucketing has no Prisma equivalent, so raw SQL. COUNT(*)::int,
    // not COUNT(*) -- Postgres returns bigint otherwise, which is not JSON
    // serializable out of a server component.
    prisma.$queryRaw<{ decade: number; count: number }[]>`
      SELECT (("publishYear" / 10) * 10)::int AS decade, COUNT(*)::int AS count
      FROM "PhysicalCopy"
      WHERE "publishYear" IS NOT NULL
      GROUP BY decade
      ORDER BY decade
    `,
    prisma.physicalCopy.count({ where: { publishYear: null } }),
```

Destructure as `formatGroups`, `publisherGroups`, `decadeRows`, `publishYearUnknown`, then:

```ts
  const formats = FORMAT_BUCKETS.map(({ label, value }) => ({
    label,
    count: formatGroups.find((g) => g.format === value)?._count._all ?? 0,
  }));

  // `publisher` is filtered non-null in the query, so the cast is safe --
  // Prisma still types the groupBy key as nullable.
  const topPublishers = publisherGroups.map((g) => ({
    label: g.publisher as string,
    count: g._count._all,
  }));

  // Only decades that actually have copies are listed. Unlike the fixed
  // bucket lists above, the range here is open-ended and data-dependent --
  // padding every empty decade between the oldest and newest book would add
  // noise, not information.
  const decades = decadeRows.map((row) => ({
    label: `${row.decade}s`,
    count: row.count,
  }));
```

Return all four in place of the empty values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- stats.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts
git commit -m "feat: add format, publisher and decade breakdowns to library stats"
```

---

### Task 4: Authors and TBR

**Files:**
- Modify: `src/lib/stats.ts`
- Test: `src/lib/stats.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("getLibraryStats authors and TBR", () => {
  it("ranks authors by book count and excludes books with no author", async () => {
    await prisma.book.create({ data: { title: "Test Stats Author A1", author: "Test Stats Sanderson" } });
    await prisma.book.create({ data: { title: "Test Stats Author A2", author: "Test Stats Sanderson" } });
    await prisma.book.create({ data: { title: "Test Stats Author B1", author: "Test Stats Le Guin" } });
    await prisma.book.create({ data: { title: "Test Stats Author None", author: null } });

    const stats = await getLibraryStats();

    expect(stats.topAuthors[0]).toEqual({ label: "Test Stats Sanderson", count: 2 });
    expect(stats.topAuthors[1]).toEqual({ label: "Test Stats Le Guin", count: 1 });
    expect(stats.topAuthors.some((a) => a.label === null || a.label === "")).toBe(false);
    expect(stats.topAuthors.reduce((n, a) => n + a.count, 0)).toBe(3);
  });

  it("splits TBR items into owned and remaining gap", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Stats Tbr Owned", owned: true },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Stats Tbr Wanted A", owned: false },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Stats Tbr Wanted B", owned: false },
    });

    const stats = await getLibraryStats();

    expect(stats.tbr.total).toBe(3);
    expect(stats.tbr.owned).toBe(1);
    expect(stats.tbr.gap).toBe(2);
    expect(stats.tbr.owned + stats.tbr.gap).toBe(stats.tbr.total);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- stats.test.ts`

- [ ] **Step 3: Implement**

Add to the `Promise.all`:

```ts
    prisma.book.groupBy({
      by: ["author"],
      where: { author: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { author: "desc" } },
      take: TOP_N,
    }),
    prisma.goodreadsTbrItem.count(),
    // Reads the `owned` column added by the TBR performance work, so this is
    // two cheap COUNTs rather than any title matching.
    prisma.goodreadsTbrItem.count({ where: { owned: true } }),
```

Destructure as `authorGroups`, `tbrTotal`, `tbrOwned`, then:

```ts
  // A missing author is absent data, not an author named "Unknown" -- those
  // books are excluded from the ranking rather than bucketed together, which
  // would otherwise often top the list and say nothing.
  const topAuthors = authorGroups.map((g) => ({
    label: g.author as string,
    count: g._count._all,
  }));
```

Return `topAuthors` and `tbr: { total: tbrTotal, owned: tbrOwned, gap: tbrTotal - tbrOwned }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- stats.test.ts`, then the full `npm test`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts
git commit -m "feat: add top authors and TBR breakdown to library stats"
```

---

### Task 5: `StatTile` and `StatBarList` components

**Files:**
- Create: `src/components/StatTile.tsx`
- Create: `src/components/StatBarList.tsx`

No automated tests — this repo has no precedent for unit-testing presentational components without behaviour. Coverage comes from Task 7's browser verification.

- [ ] **Step 1: Create `src/components/StatTile.tsx`**

```tsx
import { TicketCard } from "@/components/ui/TicketCard";

interface StatTileProps {
  label: string;
  value: number;
  /** Renders larger, for the one number the page leads with. */
  hero?: boolean;
}

// A single headline number. Per the visualization guidance a handful of
// standalone figures is a stat tile, NOT a one-bar chart -- there is no
// magnitude comparison to make between "total books" and "total copies".
export function StatTile({ label, value, hero = false }: StatTileProps) {
  return (
    <TicketCard as="div" className="p-3">
      <p
        className={
          hero
            ? "font-display text-4xl font-semibold text-foreground-strong"
            : "font-display text-2xl font-semibold text-foreground-strong"
        }
      >
        {value.toLocaleString()}
      </p>
      <p className="mt-1 text-sm text-foreground/70">{label}</p>
    </TicketCard>
  );
}
```

- [ ] **Step 2: Create `src/components/StatBarList.tsx`**

```tsx
import type { CountBucket } from "@/lib/stats";

interface StatBarListProps {
  buckets: CountBucket[];
  /** What one unit is, e.g. "books" or "copies" -- shown in hover text. */
  unit: string;
}

// Single-hue horizontal bars. Colour deliberately carries NO information:
// bar length encodes the count, and every bar is the same fill.
//
// This is a hard constraint, not a style choice. The theme's two candidate
// data colours (Sakura Ink and Bamboo) measure ΔE 0.2 apart under
// deuteranopia -- a red/green colourblind reader would see one colour -- so
// this palette cannot support multi-series categorical charts at all. See
// docs/superpowers/specs/2026-07-26-library-stats-design.md.
//
// The fill uses --link (#9C4258 light / #E8A2AC dark), the one theme colour
// that clears the >=3:1 contrast-vs-surface check in BOTH modes. Do not
// switch it to --accent: that measures 2.15:1 on the cream background.
export function StatBarList({ buckets, unit }: StatBarListProps) {
  // Scale to the largest bucket, not to the total: this compares categories
  // against each other, so the biggest bar should fill the row.
  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <ul className="space-y-2">
      {buckets.map((bucket) => (
        <li key={bucket.label} className="flex items-center gap-3">
          <span className="w-32 shrink-0 truncate text-sm text-foreground" title={bucket.label}>
            {bucket.label}
          </span>
          <span
            className="h-3 flex-1 overflow-hidden rounded-full bg-perforation/30"
            // Native title = the guidance's hover layer with no client-side
            // JS, so this whole page stays a server component.
            title={`${bucket.label}: ${bucket.count.toLocaleString()} ${unit}`}
          >
            <span
              className="block h-full rounded-full bg-link"
              style={{ width: `${(bucket.count / max) * 100}%` }}
            />
          </span>
          {/* The number is ALWAYS text, never encoded in length alone --
              this is what makes the page readable to a screen reader and
              removes any need for a separate table view. */}
          <span className="w-12 shrink-0 text-right text-sm tabular-nums text-foreground/70">
            {bucket.count.toLocaleString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Confirm the `bg-link` utility exists**

`--link` is mapped into Tailwind via the `@theme inline` block in `src/app/globals.css` (it already backs the `text-link` utility used across the app). Verify `bg-link` resolves — grep `globals.css` for how `--color-link` is declared. If only `text-link` works, add the background mapping alongside it in the same `@theme inline` block, matching the existing pattern for other colours. Do not hardcode the hex.

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/components/StatTile.tsx src/components/StatBarList.tsx src/app/globals.css
git commit -m "feat: add StatTile and StatBarList presentation components"
```

---

### Task 6: The `/stats` page and home-page link

**Files:**
- Create: `src/app/stats/page.tsx`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Create `src/app/stats/page.tsx`**

```tsx
import Link from "next/link";
import { getLibraryStats } from "@/lib/stats";
import { StatTile } from "@/components/StatTile";
import { StatBarList } from "@/components/StatBarList";

export const dynamic = "force-dynamic";

export default async function StatsPage() {
  const stats = await getLibraryStats();

  if (stats.totals.books === 0) {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h1 className="font-display text-2xl font-semibold text-foreground-strong">Library Stats</h1>
          <Link href="/" className="text-sm text-link underline">
            Back to search
          </Link>
        </div>
        <p className="text-foreground/70">
          Nothing catalogued yet — add a book and the numbers will show up here.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">Library Stats</h1>
        <Link href="/" className="text-sm text-link underline">
          Back to search
        </Link>
      </div>

      <section className="mb-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile label="Books" value={stats.totals.books} hero />
          <StatTile label="Copies" value={stats.totals.copies} />
          <StatTile label="In multiple formats" value={stats.totals.multiFormatBooks} />
          <StatTile label="Physical" value={stats.totals.physicalBooks} />
          <StatTile label="Ebook" value={stats.totals.ebookBooks} />
          <StatTile label="Audiobook" value={stats.totals.audiobookBooks} />
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-1 font-display text-lg font-semibold text-foreground-strong">Reading</h2>
        <p className="mb-2 text-sm text-foreground/70">By book</p>
        <StatBarList buckets={stats.readStatus} unit="books" />
        <h3 className="mt-4 mb-2 font-display text-base font-semibold text-foreground-strong">
          Ratings
        </h3>
        <StatBarList buckets={stats.ratings} unit="books" />
      </section>

      <section className="mb-6">
        <h2 className="mb-1 font-display text-lg font-semibold text-foreground-strong">
          Physical shelf
        </h2>
        {/* Stated in the UI, not just the code: these count physical copies,
            so two paperbacks of one title count twice -- unlike the
            book-level numbers above. */}
        <p className="mb-2 text-sm text-foreground/70">By copy</p>
        <StatBarList buckets={stats.formats} unit="copies" />

        {stats.decades.length > 0 && (
          <>
            <h3 className="mt-4 mb-2 font-display text-base font-semibold text-foreground-strong">
              Published
            </h3>
            <StatBarList buckets={stats.decades} unit="copies" />
            {stats.publishYearUnknown > 0 && (
              <p className="mt-2 text-sm text-foreground/70">
                {stats.publishYearUnknown.toLocaleString()} cop
                {stats.publishYearUnknown === 1 ? "y has" : "ies have"} no publish year recorded.
              </p>
            )}
          </>
        )}

        {stats.topPublishers.length > 0 && (
          <>
            <h3 className="mt-4 mb-2 font-display text-base font-semibold text-foreground-strong">
              Top publishers
            </h3>
            <StatBarList buckets={stats.topPublishers} unit="copies" />
          </>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-1 font-display text-lg font-semibold text-foreground-strong">Authors</h2>
        <p className="mb-2 text-sm text-foreground/70">By book</p>
        {stats.topAuthors.length > 0 ? (
          <StatBarList buckets={stats.topAuthors} unit="books" />
        ) : (
          <p className="text-sm text-foreground/70">No authors recorded yet.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-display text-lg font-semibold text-foreground-strong">
          To-read shelf
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="On the shelf" value={stats.tbr.total} />
          <StatTile label="Already owned" value={stats.tbr.owned} />
          <StatTile label="Still to get" value={stats.tbr.gap} />
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 2: Add the link to `src/app/page.tsx`**

The home page has this nav row:

```tsx
      <div className="mb-4 flex gap-4 text-sm">
        <Link href="/books" className="text-link underline">
          Manage all books
        </Link>
        <Link href="/tbr" className="text-link underline">
          TBR gap view
        </Link>
      </div>
```

Add a third link, matching the existing style exactly:

```tsx
        <Link href="/stats" className="text-link underline">
          Library stats
        </Link>
```

- [ ] **Step 3: Verify**

Run: `npm run build` — expect success and `/stats` listed in the route output.
Run: `npm run lint` — expect no NEW findings. (There is 1 pre-existing error in `CoverPicker.tsx` and 1 pre-existing warning in `actions/copies.ts`; neither is yours.)
Run: `npm test` — full suite passing.

- [ ] **Step 4: Commit**

```bash
git add src/app/stats/page.tsx src/app/page.tsx
git commit -m "feat: add /stats page and home-page link"
```

---

### Task 7: Reconciliation test and browser verification

**Files:**
- Modify: `src/lib/stats.test.ts`

- [ ] **Step 1: Add the reconciliation test**

This is the test that catches a future edit silently mixing book-level and copy-level counting — the specific failure mode the spec calls out.

```ts
describe("getLibraryStats reconciliation", () => {
  it("keeps book-level and copy-level totals internally consistent", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Reconcile One",
        author: "Test Stats Reconcile Author",
        readStatus: "READ",
        rating: 4,
        copies: { create: [{ format: "HARDCOVER" }, { format: "PAPERBACK" }] },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Stats Reconcile Two",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-stats-reconcile-audio" } },
      },
    });

    const stats = await getLibraryStats();

    // Every book lands in exactly one read-status bucket and one rating bucket.
    expect(stats.readStatus.reduce((n, b) => n + b.count, 0)).toBe(stats.totals.books);
    expect(stats.ratings.reduce((n, b) => n + b.count, 0)).toBe(stats.totals.books);

    // Every physical copy lands in exactly one format bucket.
    const physicalCopies = await prisma.physicalCopy.count();
    expect(stats.formats.reduce((n, b) => n + b.count, 0)).toBe(physicalCopies);

    // Decade buckets plus the no-year count cover every physical copy.
    expect(stats.decades.reduce((n, b) => n + b.count, 0) + stats.publishYearUnknown).toBe(
      physicalCopies,
    );

    // TBR splits cleanly.
    expect(stats.tbr.owned + stats.tbr.gap).toBe(stats.tbr.total);

    // Book-level and copy-level numbers genuinely differ here, which is the
    // whole point of tracking them separately.
    expect(stats.totals.copies).toBeGreaterThan(stats.totals.books);
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all passing.

- [ ] **Step 3: Verify in a real browser**

Follow this project's established verification pattern (see `docs/superpowers/plans/2026-07-25-tbr-ownership-tracking.md` Task 13 for the exact approach):

1. Seed a realistic fixture into the **isolated test database** (`bookcatalog_test`) — several hundred books with a mix of formats, ratings, statuses, publishers, publish years, authors, and TBR items both owned and not. **Never seed the shared dev DB (`bookcatalog`).**
2. Start a dev server with an inline `DATABASE_URL` override pointing at the test DB — never edit `.env` or `.env.test`.
3. Mint a session cookie with `iron-session`'s `sealData({ authenticated: true }, { password: SESSION_SECRET })` and set it via Playwright's `addCookies` (the cookie is `httpOnly`, so `document.cookie` will not work).
4. Confirm: every section renders; bars are proportional; the largest bucket fills its row; numbers appear as text beside every bar; the decade list is in ascending order.
5. **Check both light and dark mode** — the bar fill uses `--link`, which has a hand-picked dark value. Confirm the bars are clearly visible against the surface in each.
6. Confirm the empty state by pointing at a database with zero books.
7. Kill the dev server and delete every seeded row, confirming zero remain.

- [ ] **Step 4: Commit**

```bash
git add src/lib/stats.test.ts
git commit -m "test: add library stats reconciliation test"
```
