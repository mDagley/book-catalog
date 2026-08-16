# Books Cover Grid View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cover-forward grid view (with a grid/list toggle) to `/books`, `/`, `/books/[id]`, and `/books/duplicates`, matching the layout language of the reference site while keeping this app's existing Sakura Postal / Library Ticket theme.

**Architecture:** A new `ViewMode` cookie preference (`grid`/`list`, per view) mirrors the existing `Density` cookie exactly (`src/lib/density.ts` / `src/lib/actions/density.ts`). A new `CoverGridCard` component renders the poster-style card (2:3 cover, corner badges, minimal text) and is swapped in for the existing `CatalogResultCard` when a page's view mode is `grid`. The book detail page and duplicates page get smaller, targeted cover treatments that don't need the toggle infrastructure.

**Tech Stack:** Next.js App Router (server components, server actions, cookie-backed preferences), Prisma, Tailwind CSS v4, Vitest (`environment: "node"`, components tested via `renderToStaticMarkup` + string assertions — this codebase has no jsdom/testing-library).

Reference spec: `docs/superpowers/specs/2026-08-15-books-cover-grid-view-design.md`.

---

## Task 1: `ViewMode` preference module

**Files:**
- Create: `src/lib/viewMode.ts`
- Test: `src/lib/viewMode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/viewMode.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const cookieStore = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.has(name) ? { name, value: cookieStore.get(name)! } : undefined,
  }),
}));

import { getViewMode, viewModeCookieName } from "@/lib/viewMode";

beforeEach(() => {
  cookieStore.clear();
});

describe("getViewMode", () => {
  it("defaults to grid for the books view when no cookie is set", async () => {
    expect(await getViewMode("books")).toBe("grid");
  });

  it("defaults to list for the home view when no cookie is set", async () => {
    expect(await getViewMode("home")).toBe("list");
  });

  it("honors a stored cookie value over the default", async () => {
    cookieStore.set(viewModeCookieName("books"), "list");
    expect(await getViewMode("books")).toBe("list");
  });

  it("falls back to the default for a garbage cookie value", async () => {
    cookieStore.set(viewModeCookieName("home"), "bogus");
    expect(await getViewMode("home")).toBe("list");
  });

  it("uses a distinct cookie name per view", () => {
    expect(viewModeCookieName("books")).not.toBe(viewModeCookieName("home"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/viewMode.test.ts`
Expected: FAIL — `Cannot find module '@/lib/viewMode'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/viewMode.ts
import { cookies } from "next/headers";

export type ViewMode = "grid" | "list";
export type ViewModeView = "books" | "home";

// /books defaults to grid (browsing a large library benefits from covers,
// matching the reference site's default); / defaults to list (a "do I
// already own this?" lookup is usually 1-3 results, and the existing
// comfortable list card already shows a large cover per result).
const DEFAULTS: Record<ViewModeView, ViewMode> = {
  books: "grid",
  home: "list",
};

export function viewModeCookieName(view: ViewModeView): string {
  return `view-${view}`;
}

// Cookie rather than localStorage, exactly like density.ts: this app is
// server-component-first, so reading the cookie during render means the
// correct view is in the FIRST HTML response -- no hydration flash.
export async function getViewMode(view: ViewModeView): Promise<ViewMode> {
  const store = await cookies();
  const value = store.get(viewModeCookieName(view))?.value;
  return value === "grid" || value === "list" ? value : DEFAULTS[view];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/viewMode.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/viewMode.ts src/lib/viewMode.test.ts
git commit -m "feat: add ViewMode cookie preference (grid/list) per view"
```

---

## Task 2: `setViewMode` server action

**Files:**
- Create: `src/lib/actions/viewMode.ts`

No dedicated test — `src/lib/actions/density.ts` (the pattern this mirrors exactly) has none either; it's a thin cookie-write wrapper exercised via the pages that call it.

- [ ] **Step 1: Write the implementation**

```ts
// src/lib/actions/viewMode.ts
"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { viewModeCookieName, type ViewMode, type ViewModeView } from "@/lib/viewMode";

const VIEW_PATHS: Record<ViewModeView, string> = {
  books: "/books",
  home: "/",
};

export async function setViewMode(view: ViewModeView, mode: ViewMode): Promise<void> {
  const store = await cookies();
  store.set(viewModeCookieName(view), mode, {
    // A single-user personal app has no session boundary this should
    // expire at -- effectively "remember until they change it again".
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
  revalidatePath(VIEW_PATHS[view]);
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `src/lib/actions/viewMode.ts`

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/viewMode.ts
git commit -m "feat: add setViewMode server action"
```

---

## Task 3: Format badge icons

**Files:**
- Create: `src/components/FormatBadgeIcons.tsx`
- Test: `src/components/FormatBadgeIcons.test.tsx`

Small inline SVGs in the same hand-kept style as `src/components/PandaStamp.tsx` (plain shapes, `currentColor`, no icon library) — one each for physical/ebook/audiobook, used as corner badges on `CoverGridCard`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/FormatBadgeIcons.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhysicalBookIcon, EbookIcon, AudiobookIcon } from "@/components/FormatBadgeIcons";

describe("FormatBadgeIcons", () => {
  it("renders each icon as a presentational svg with no title by default", () => {
    for (const Icon of [PhysicalBookIcon, EbookIcon, AudiobookIcon]) {
      const html = renderToStaticMarkup(<Icon />);
      expect(html).toContain("<svg");
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain("<title>");
    }
  });

  it("renders an accessible title and role=img when title is given", () => {
    const html = renderToStaticMarkup(<PhysicalBookIcon title="Physical copy" />);
    expect(html).toContain('role="img"');
    expect(html).toContain("<title>Physical copy</title>");
    expect(html).not.toContain('aria-hidden');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/FormatBadgeIcons.test.tsx`
Expected: FAIL — `Cannot find module '@/components/FormatBadgeIcons'`

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/FormatBadgeIcons.tsx
interface IconProps {
  className?: string;
  title?: string;
}

// Three minimal corner-badge icons for CoverGridCard, matching PandaStamp's
// hand-drawn-shapes style (no icon library) so they read as part of this
// app's own visual language, not an imported icon set.

export function PhysicalBookIcon({ className, title }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path
        d="M4 4.5C4 3.67 4.67 3 5.5 3H12V21H5.5C4.67 21 4 20.33 4 19.5V4.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M20 4.5C20 3.67 19.33 3 18.5 3H12V21H18.5C19.33 21 20 20.33 20 19.5V4.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function EbookIcon({ className, title }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <rect x="5" y="2" width="14" height="20" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}

export function AudiobookIcon({ className, title }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 9v6M12 7.5v9M15 9v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/FormatBadgeIcons.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/FormatBadgeIcons.tsx src/components/FormatBadgeIcons.test.tsx
git commit -m "feat: add format badge icons for cover grid cards"
```

---

## Task 4: `CoverGridCard` component

**Files:**
- Create: `src/components/CoverGridCard.tsx`
- Test: `src/components/CoverGridCard.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/CoverGridCard.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverGridCard } from "@/components/CoverGridCard";
import type { SearchResult } from "@/lib/search";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "Test Book",
    author: "Test Author",
    bookId: "book-1",
    physicalCopies: [],
    hasEbook: false,
    hasAudiobook: false,
    readStatus: null,
    rating: null,
    coverImagePath: null,
    ...overrides,
  };
}

describe("CoverGridCard", () => {
  it("renders the placeholder tile when there is no cover", () => {
    const html = renderToStaticMarkup(<CoverGridCard result={makeResult()} />);
    expect(html).toContain("📖"); // 📖
    expect(html).not.toContain("<img");
  });

  it("renders the cover image when a cover path is set", () => {
    const html = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ coverImagePath: "abc.jpg" })} />,
    );
    expect(html).toContain("/api/covers/abc.jpg");
  });

  it("renders the Read badge only when readStatus is READ", () => {
    const read = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ readStatus: "READ" })} />,
    );
    const unread = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ readStatus: "TO_READ" })} />,
    );
    expect(read).toContain("Read");
    expect(unread).not.toContain(">Read<");
  });

  it("renders one format badge per owned format", () => {
    const html = renderToStaticMarkup(
      <CoverGridCard
        result={makeResult({
          physicalCopies: [{ id: "c1", format: "HARDCOVER", publisher: null, publishYear: null }],
          hasEbook: true,
          hasAudiobook: true,
        })}
      />,
    );
    expect(html).toContain("Physical copy");
    expect(html).toContain("Ebook");
    expect(html).toContain("Audiobook");
  });

  it("wraps the card in a link to the book when bookId is present", () => {
    const html = renderToStaticMarkup(<CoverGridCard result={makeResult()} />);
    expect(html).toContain('href="/books/book-1"');
  });

  it("shows title and author as text below the cover", () => {
    const html = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ title: "Dune", author: "Frank Herbert" })} />,
    );
    expect(html).toContain("Dune");
    expect(html).toContain("Frank Herbert");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/CoverGridCard.test.tsx`
Expected: FAIL — `Cannot find module '@/components/CoverGridCard'`

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/CoverGridCard.tsx
import Link from "next/link";
import type { ReactNode } from "react";
import type { SearchResult } from "@/lib/search";
import { PandaStamp } from "@/components/PandaStamp";
import { PhysicalBookIcon, EbookIcon, AudiobookIcon } from "@/components/FormatBadgeIcons";
import { TicketCard } from "@/components/ui/TicketCard";

interface FormatBadge {
  key: string;
  icon: ReactNode;
}

// Poster-style card for the grid view: full-bleed 2:3 cover with small
// corner badges (read status, owned formats) and minimal text below --
// the badges replace the text meta line CatalogResultCard shows, per the
// design spec's "corner badges + minimal text" choice.
export function CoverGridCard({ result }: { result: SearchResult }) {
  const formatBadges: FormatBadge[] = [
    ...(result.physicalCopies.length > 0
      ? [{ key: "physical", icon: <PhysicalBookIcon title="Physical copy" className="h-4 w-4" /> }]
      : []),
    ...(result.hasEbook
      ? [{ key: "ebook", icon: <EbookIcon title="Ebook" className="h-4 w-4" /> }]
      : []),
    ...(result.hasAudiobook
      ? [{ key: "audiobook", icon: <AudiobookIcon title="Audiobook" className="h-4 w-4" /> }]
      : []),
  ];

  const card = (
    <TicketCard as="div" className="flex h-full flex-col overflow-hidden p-0">
      <div className="relative aspect-[2/3] w-full bg-surface">
        {result.coverImagePath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/covers/${encodeURIComponent(result.coverImagePath)}`}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-3xl text-foreground/40"
            aria-hidden="true"
          >
            📖
          </div>
        )}
        {result.readStatus === "READ" && (
          <PandaStamp
            title="Read"
            className="absolute right-2 top-2 h-5 w-5 rounded-full bg-background/80 p-0.5 text-status-positive"
          />
        )}
        {formatBadges.length > 0 && (
          <div className="absolute left-2 top-2 flex flex-col gap-1">
            {formatBadges.map((badge) => (
              <span key={badge.key} className="rounded-full bg-background/80 p-0.5 text-foreground-strong">
                {badge.icon}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex-1 p-2">
        <p className="line-clamp-2 font-display text-sm font-semibold text-foreground-strong">
          {result.title}
        </p>
        {result.author && <p className="line-clamp-1 text-xs text-foreground/70">{result.author}</p>}
      </div>
    </TicketCard>
  );

  return (
    <li data-testid="catalog-grid-item">
      {result.bookId ? (
        <Link href={`/books/${result.bookId}`} aria-label={result.title} className="block h-full">
          {card}
        </Link>
      ) : (
        card
      )}
    </li>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/CoverGridCard.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/CoverGridCard.tsx src/components/CoverGridCard.test.tsx
git commit -m "feat: add CoverGridCard poster-style grid card"
```

---

## Task 5: Add `coverImagePath` to duplicate candidates

**Files:**
- Modify: `src/lib/duplicates.ts`
- Test: `src/lib/duplicates.test.ts`

Adds a resolved cover to each `DuplicateCandidate` (reusing `resolveListingCover`, already used for the same purpose in `search.ts`) so the duplicates page can show a thumbnail per candidate.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("findDuplicateBookGroups", ...)` block in `src/lib/duplicates.test.ts`, right after the existing `"reports copy count and ebook/audiobook flags per candidate"` test (after line 321):

```ts
  it("reports each candidate's resolved cover image path", async () => {
    const withCover = await prisma.book.create({
      data: {
        title: "Test Duplicates Cover Field Book",
        copies: { create: { format: "HARDCOVER", coverImagePath: "physical-cover.jpg" } },
      },
    });
    const withoutCover = await prisma.book.create({
      data: {
        title: "Test Duplicates Cover Field Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-cover-item" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();
    const group = groups.find((g) => g.books.some((book) => book.id === withCover.id));

    const covered = group?.books.find((book) => book.id === withCover.id);
    const uncovered = group?.books.find((book) => book.id === withoutCover.id);
    expect(covered?.coverImagePath).toBe("physical-cover.jpg");
    expect(uncovered?.coverImagePath).toBeNull();
  });
```

Also add this test inside the existing `describe("refreshDuplicateGroupsCache / getDuplicateGroups", ...)` block, after the last existing test in that block (after line 668's test body closes):

```ts
  it("getDuplicateGroups also reports each candidate's cover image path", async () => {
    const withCover = await prisma.book.create({
      data: {
        title: "Test Duplicates Cached Cover Book",
        copies: { create: { format: "HARDCOVER", coverImagePath: "cached-cover.jpg" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Duplicates Cached Cover Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-cached-cover-item" } },
      },
    });

    await refreshDuplicateGroupsCache();
    const { groups } = await getDuplicateGroups();
    const group = groups.find((g) => g.books.some((book) => book.id === withCover.id));
    const covered = group?.books.find((book) => book.id === withCover.id);
    expect(covered?.coverImagePath).toBe("cached-cover.jpg");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/duplicates.test.ts`
Expected: FAIL — `coverImagePath` is `undefined`, not `"physical-cover.jpg"` / `null` (property doesn't exist yet on `DuplicateCandidate`)

- [ ] **Step 3: Implement**

In `src/lib/duplicates.ts`, add the import:

```ts
import { resolveListingCover } from "@/lib/listingCover";
```

Add `coverImagePath` to the interface:

```ts
export interface DuplicateCandidate {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  copiesCount: number;
  hasEbook: boolean;
  hasAudiobook: boolean;
  coverImagePath: string | null;
}
```

In `findDuplicateBookGroups()`, change the `prisma.book.findMany` call's `select` to also fetch the three copy relations' cover fields:

```ts
  const books = await prisma.book.findMany({
    select: {
      id: true,
      title: true,
      author: true,
      isbn: true,
      hasEbook: true,
      hasAudiobook: true,
      _count: { select: { copies: true } },
      copies: { select: { coverImagePath: true } },
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const candidates: DuplicateCandidate[] = books.map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author,
    isbn: book.isbn,
    copiesCount: book._count.copies,
    hasEbook: book.hasEbook,
    hasAudiobook: book.hasAudiobook,
    coverImagePath: resolveListingCover(book),
  }));
```

In `getDuplicateGroups()`, change the `include.books.select` the same way, and add the field to the return mapping:

```ts
      prisma.duplicateGroup.findMany({
        include: {
          books: {
            select: {
              id: true,
              title: true,
              author: true,
              isbn: true,
              hasEbook: true,
              hasAudiobook: true,
              _count: { select: { copies: true } },
              copies: { select: { coverImagePath: true } },
              ebookCopies: { select: { coverImagePath: true } },
              audiobookCopies: { select: { coverImagePath: true } },
            },
          },
        },
```

and:

```ts
      books: group.books.map((book) => ({
        id: book.id,
        title: book.title,
        author: book.author,
        isbn: book.isbn,
        copiesCount: book._count.copies,
        hasEbook: book.hasEbook,
        hasAudiobook: book.hasAudiobook,
        coverImagePath: resolveListingCover(book),
      })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/duplicates.test.ts`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/lib/duplicates.ts src/lib/duplicates.test.ts
git commit -m "feat: resolve each duplicate candidate's cover image path"
```

---

## Task 6: Show cover thumbnails on the duplicates page

**Files:**
- Modify: `src/app/books/duplicates/page.tsx`

- [ ] **Step 1: Add the `CoverThumbnail` import**

In `src/app/books/duplicates/page.tsx`, add:

```ts
import { CoverThumbnail } from "@/components/CoverThumbnail";
```

- [ ] **Step 2: Add a thumbnail to each candidate row**

Replace this block:

```tsx
                {group.books.map((book) => (
                  <li key={book.id} className="rounded-lg border border-perforation p-2 text-sm">
                    <p className="font-medium text-foreground-strong">{book.title}</p>
                    {book.author && <p className="text-foreground/70">{book.author}</p>}
                    {book.isbn && <p className="font-mono text-foreground/70">ISBN: {book.isbn}</p>}
                    <p className="text-foreground/70">
                      {book.copiesCount} {book.copiesCount === 1 ? "copy" : "copies"}
                      {book.hasEbook ? ", ebook" : ""}
                      {book.hasAudiobook ? ", audiobook" : ""}
                    </p>
                    <form
                      action={mergeBooks.bind(
                        null,
                        book.id,
                        group.books.filter((other) => other.id !== book.id).map((other) => other.id),
                      )}
                    >
                      <MergeButton />
                    </form>
                  </li>
                ))}
```

with:

```tsx
                {group.books.map((book) => (
                  <li key={book.id} className="flex gap-3 rounded-lg border border-perforation p-2 text-sm">
                    <CoverThumbnail coverImagePath={book.coverImagePath} size="compact" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground-strong">{book.title}</p>
                      {book.author && <p className="text-foreground/70">{book.author}</p>}
                      {book.isbn && <p className="font-mono text-foreground/70">ISBN: {book.isbn}</p>}
                      <p className="text-foreground/70">
                        {book.copiesCount} {book.copiesCount === 1 ? "copy" : "copies"}
                        {book.hasEbook ? ", ebook" : ""}
                        {book.hasAudiobook ? ", audiobook" : ""}
                      </p>
                      <form
                        action={mergeBooks.bind(
                          null,
                          book.id,
                          group.books.filter((other) => other.id !== book.id).map((other) => other.id),
                        )}
                      >
                        <MergeButton />
                      </form>
                    </div>
                  </li>
                ))}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `src/app/books/duplicates/page.tsx`

- [ ] **Step 4: Commit**

```bash
git add src/app/books/duplicates/page.tsx
git commit -m "feat: show cover thumbnails on the duplicates page"
```

---

## Task 7: Grid view on `/books`

**Files:**
- Modify: `src/app/books/page.tsx`

- [ ] **Step 1: Add imports**

Add alongside the existing imports at the top of `src/app/books/page.tsx`:

```ts
import { getViewMode } from "@/lib/viewMode";
import { setViewMode } from "@/lib/actions/viewMode";
import { CoverGridCard } from "@/components/CoverGridCard";
```

- [ ] **Step 2: Read the view mode**

Directly below the existing `const density = await getDensity("books");` line, add:

```ts
  const viewMode = await getViewMode("books");
```

- [ ] **Step 3: Add the grid/list toggle, hide density toggle in grid view**

Replace:

```tsx
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/70">
        <p>
          {results.length === totalCount
            ? `${totalCount} book${totalCount === 1 ? "" : "s"}`
            : `Showing ${results.length} of ${totalCount} book${totalCount === 1 ? "" : "s"}`}
        </p>
        <form action={setDensity.bind(null, "books", density === "compact" ? "comfortable" : "compact")}>
          <button type="submit" className="text-link underline">
            {density === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
          </button>
        </form>
      </div>
```

with:

```tsx
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-foreground/70">
        <p>
          {results.length === totalCount
            ? `${totalCount} book${totalCount === 1 ? "" : "s"}`
            : `Showing ${results.length} of ${totalCount} book${totalCount === 1 ? "" : "s"}`}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <form action={setViewMode.bind(null, "books", viewMode === "grid" ? "list" : "grid")}>
            <button type="submit" className="text-link underline">
              {viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
            </button>
          </form>
          {viewMode === "list" && (
            <form
              action={setDensity.bind(null, "books", density === "compact" ? "comfortable" : "compact")}
            >
              <button type="submit" className="text-link underline">
                {density === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
              </button>
            </form>
          )}
        </div>
      </div>
```

- [ ] **Step 4: Branch the results list on view mode**

Replace:

```tsx
          <ul className={density === "compact" ? "space-y-1" : "space-y-3"}>
            {results.map((result) => (
              <CatalogResultCard key={result.bookId ?? result.title} result={result} density={density} />
            ))}
          </ul>
```

with:

```tsx
          {viewMode === "grid" ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
              {results.map((result) => (
                <CoverGridCard key={result.bookId ?? result.title} result={result} />
              ))}
            </ul>
          ) : (
            <ul className={density === "compact" ? "space-y-1" : "space-y-3"}>
              {results.map((result) => (
                <CatalogResultCard key={result.bookId ?? result.title} result={result} density={density} />
              ))}
            </ul>
          )}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `src/app/books/page.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/app/books/page.tsx
git commit -m "feat: add grid/list view toggle to /books"
```

---

## Task 8: Grid view on `/` (home)

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Add imports**

Add alongside the existing imports at the top of `src/app/page.tsx`:

```ts
import { getViewMode } from "@/lib/viewMode";
import { setViewMode } from "@/lib/actions/viewMode";
import { CoverGridCard } from "@/components/CoverGridCard";
```

- [ ] **Step 2: Read the view mode**

Directly below the existing `const density = await getDensity("home");` line, add:

```ts
  const viewMode = await getViewMode("home");
```

- [ ] **Step 3: Add the grid/list toggle, hide density toggle in grid view**

Replace:

```tsx
        <form action={setDensity.bind(null, "home", density === "compact" ? "comfortable" : "compact")}>
          <button type="submit" className="text-link underline">
            {density === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
          </button>
        </form>
      </div>
```

with:

```tsx
        <div className="flex flex-wrap items-center gap-4">
          <form action={setViewMode.bind(null, "home", viewMode === "grid" ? "list" : "grid")}>
            <button type="submit" className="text-link underline">
              {viewMode === "grid" ? "Switch to list view" : "Switch to grid view"}
            </button>
          </form>
          {viewMode === "list" && (
            <form
              action={setDensity.bind(null, "home", density === "compact" ? "comfortable" : "compact")}
            >
              <button type="submit" className="text-link underline">
                {density === "compact" ? "Switch to comfortable view" : "Switch to compact view"}
              </button>
            </form>
          )}
        </div>
      </div>
```

- [ ] **Step 4: Branch the results list on view mode**

Replace:

```tsx
      {results.length > 0 && (
        <ul className={density === "compact" ? "space-y-1" : "space-y-3"}>
          {results.map((result) => (
            <CatalogResultCard key={result.bookId ?? result.title} result={result} density={density} />
          ))}
        </ul>
      )}
```

with:

```tsx
      {results.length > 0 &&
        (viewMode === "grid" ? (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {results.map((result) => (
              <CoverGridCard key={result.bookId ?? result.title} result={result} />
            ))}
          </ul>
        ) : (
          <ul className={density === "compact" ? "space-y-1" : "space-y-3"}>
            {results.map((result) => (
              <CatalogResultCard key={result.bookId ?? result.title} result={result} density={density} />
            ))}
          </ul>
        ))}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `src/app/page.tsx`

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: add grid/list view toggle to home search"
```

---

## Task 9: Poster-sized hero cover on the book detail page

**Files:**
- Modify: `src/app/books/[id]/page.tsx`

- [ ] **Step 1: Add imports**

Add alongside the existing imports at the top of `src/app/books/[id]/page.tsx`:

```ts
import { resolveListingCover } from "@/lib/listingCover";
import { PandaStamp } from "@/components/PandaStamp";
```

- [ ] **Step 2: Resolve the hero cover**

Directly below the existing `if (!book) { notFound(); }` block, add:

```ts
  const heroCoverPath = resolveListingCover(book);
```

- [ ] **Step 3: Render the hero cover beside the title**

Replace:

```tsx
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground-strong">{book.title}</h1>
          {book.author && <p className="text-foreground/70">{book.author}</p>}
          {book.isbn && <p className="font-mono text-sm text-foreground/70">ISBN: {book.isbn}</p>}
        </div>
        <Link
          href={`/books/${book.id}/edit`}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
        >
          Edit
        </Link>
      </div>
```

with:

```tsx
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-start gap-4">
          {heroCoverPath && (
            <div className="relative aspect-[2/3] w-32 shrink-0 overflow-hidden rounded-lg border border-dashed border-perforation bg-surface">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/covers/${encodeURIComponent(heroCoverPath)}`}
                alt="Cover"
                className="h-full w-full object-cover"
              />
              {book.readStatus === "READ" && (
                <PandaStamp
                  title="Read"
                  className="absolute right-2 top-2 h-6 w-6 rounded-full bg-background/80 p-1 text-status-positive"
                />
              )}
            </div>
          )}
          <div>
            <h1 className="font-display text-2xl font-semibold text-foreground-strong">{book.title}</h1>
            {book.author && <p className="text-foreground/70">{book.author}</p>}
            {book.isbn && <p className="font-mono text-sm text-foreground/70">ISBN: {book.isbn}</p>}
          </div>
        </div>
        <Link
          href={`/books/${book.id}/edit`}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
        >
          Edit
        </Link>
      </div>
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `src/app/books/[id]/page.tsx`

- [ ] **Step 5: Commit**

```bash
git add "src/app/books/[id]/page.tsx"
git commit -m "feat: show a poster-sized hero cover on the book detail page"
```

---

## Task 10: Full test suite and manual browser verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including every test added in Tasks 1, 3, 4, and 5

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Start the dev server**

Run: `npm run dev`

- [ ] **Step 4: Verify `/books` in a browser**

- Loads in grid view by default; covers are `2:3`, format/read badges appear in the correct corners, no overlap when a book has both a read badge and multiple format badges.
- "Switch to list view" toggles to the existing list layout (with its own density toggle reappearing); toggling back to grid persists across a page reload (cookie).
- Grid reflows correctly at a 390px viewport width (`auto-fill`/`minmax(160px,1fr)`).
- Search, sort, filters, jump-to-letter, and "Load more" all still work identically in both view modes.

- [ ] **Step 5: Verify `/` (home) in a browser**

- Loads in list view by default; grid/list toggle is present and works; density toggle only shows in list view.

- [ ] **Step 6: Verify `/books/[id]` in a browser**

- A book with at least one cover (physical, ebook, or audiobook) shows the poster-sized hero image beside the title; a book with none shows no hero (no layout gap/placeholder box).
- A book with `readStatus: READ` shows the panda-stamp badge on the hero cover's top-right corner.

- [ ] **Step 7: Verify `/books/duplicates` in a browser**

- Each candidate in a duplicate group shows its own small cover thumbnail (or the placeholder if it has none), not another candidate's cover.

- [ ] **Step 8: Verify both light and dark theme**

Toggle the OS/browser color scheme (or however this app's theme switching is triggered) and re-check the grid, hero cover, and duplicate thumbnails above for contrast/legibility of the corner badges (`bg-background/80` badge backgrounds).

---

## Task 11: Finish the branch

Once Task 10's verification is complete, use the `superpowers:finishing-a-development-branch` skill to decide how to integrate this work (merge, PR, or further cleanup).
