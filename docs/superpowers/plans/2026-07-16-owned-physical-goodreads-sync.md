# Owned-Physical Goodreads Shelf Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the user's custom Goodreads shelf `owned-physical` into the catalog, creating `Book`/`PhysicalCopy` rows for books tagged there that aren't yet in the catalog, and adding a placeholder physical copy to books that already exist but have no physical copy yet — running automatically alongside the existing Goodreads sync.

**Architecture:** A new, separate sync function (`syncOwnedPhysicalBooks`) reuses the existing shelf-fetching infrastructure (`fetchAllGoodreadsBooks`, now loosened to accept any shelf name string) and the existing shared fuzzy-title-matcher (`findBestTitleMatch`). It never removes data — only adds a `Book`/`PhysicalCopy` when nothing already covers a shelf item.

**Tech Stack:** Next.js 16 App Router, Prisma 7, PostgreSQL, Vitest (against the real dev database, per this project's convention).

**Spec:** `docs/superpowers/specs/2026-07-16-owned-physical-goodreads-sync-design.md`

---

## Task 1: Loosen `GoodreadsShelf` Typing to Accept Custom Shelf Names

**Files:**
- Modify: `src/lib/goodreadsSync.ts`

- [ ] **Step 1: Change `fetchGoodreadsPage`/`fetchAllGoodreadsBooks`'s `shelf` parameter type from `GoodreadsShelf` to `string`**

In `src/lib/goodreadsSync.ts`, change the signature of `fetchGoodreadsPage`:

```typescript
export async function fetchGoodreadsPage(
  userId: string,
  shelf: string,
  page: number,
): Promise<GoodreadsBook[]> {
```

(was `shelf: GoodreadsShelf`)

And `fetchAllGoodreadsBooks`:

```typescript
export async function fetchAllGoodreadsBooks(
  userId: string,
  shelf: string,
): Promise<GoodreadsBook[]> {
```

(was `shelf: GoodreadsShelf`)

Nothing else in the file changes — both functions already treat `shelf` as an opaque string (only used in `url.searchParams.set("shelf", shelf)` and error message template literals), and every existing call site passes a `GoodreadsShelf` value, which is a subtype of `string`, so no other code in this file needs to change. `GoodreadsShelf`, `STATUS_SYNC_SHELVES`, `SHELF_READ_STATUS`, `applyShelfToBooks`, and `syncGoodreadsTbr` are all unaffected.

- [ ] **Step 2: Verify nothing broke**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`
Expected: PASS, all existing tests (this is a type-only change, no behavior differs for the three existing shelf values).

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/goodreadsSync.ts
git commit -m "refactor: loosen fetchGoodreadsPage/fetchAllGoodreadsBooks shelf param to string"
```

---

## Task 2: `src/lib/ownedPhysicalSync.ts`

**Files:**
- Create: `src/lib/ownedPhysicalSync.ts`
- Create: `src/lib/ownedPhysicalSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ownedPhysicalSync.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { syncOwnedPhysicalBooks, DEFAULT_OWNED_PHYSICAL_SHELF } from "@/lib/ownedPhysicalSync";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Owned Physical" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Owned Physical" } } });
});

// Builds a minimal shelf RSS page from a list of items -- mirrors the same
// helper goodreadsSync.test.ts uses for its own shelf-based tests.
function buildRssPage(items: Array<{ title: string; author?: string; isbn13?: string }>): string {
  const itemsXml = items
    .map(
      (i) => `
    <item>
      <title>${i.title}</title>
      <author_name>${i.author ?? ""}</author_name>
      <isbn13>${i.isbn13 ?? ""}</isbn13>
    </item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>${itemsXml}</channel></rss>`;
}

const EMPTY_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel></channel></rss>`;

// Mocks a single page of shelf content, then an empty page to end pagination
// -- matches how fetchAllGoodreadsBooks stops once a page comes back empty.
function mockShelfFetch(pageContent: string): void {
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, text: async () => pageContent } as Response)
    .mockResolvedValue({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);
}

describe("syncOwnedPhysicalBooks", () => {
  it("attaches a placeholder copy to an existing book matched by ISBN", async () => {
    const existing = await prisma.book.create({
      data: { title: "Test Owned Physical ISBN Match Book", isbn: "9781112223334" },
    });

    mockShelfFetch(
      buildRssPage([
        { title: "A Completely Different Title", isbn13: "9781112223334" },
      ]),
    );

    const result = await syncOwnedPhysicalBooks("1993628", "owned-physical");

    expect(result).toEqual({ synced: 1 });
    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1);
    expect(updated.copies[0].format).toBe("OTHER");
    expect(updated.title).toBe("Test Owned Physical ISBN Match Book"); // not overwritten
  });

  it("attaches a placeholder copy to an existing book matched by fuzzy title when no ISBN matches", async () => {
    const existing = await prisma.book.create({
      data: { title: "Test Owned Physical Fuzzy Match Book", hasEbook: true, absEbookItemIds: ["owned-test-ebook"] },
    });

    mockShelfFetch(buildRssPage([{ title: "Test Owned Physical Fuzzy Match Book" }]));

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1);
    expect(updated.hasEbook).toBe(true); // untouched
  });

  it("skips a match that already has a physical copy", async () => {
    const existing = await prisma.book.create({
      data: {
        title: "Test Owned Physical Already Covered Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    mockShelfFetch(buildRssPage([{ title: "Test Owned Physical Already Covered Book" }]));

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1);
    expect(updated.copies[0].format).toBe("HARDCOVER"); // still the original, no second copy added
  });

  it("creates a new book with a placeholder copy when no match exists", async () => {
    mockShelfFetch(
      buildRssPage([
        { title: "Test Owned Physical Brand New Book", author: "Some Author", isbn13: "9789998887776" },
      ]),
    );

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const created = await prisma.book.findFirstOrThrow({
      where: { title: "Test Owned Physical Brand New Book" },
      include: { copies: true },
    });
    expect(created.author).toBe("Some Author");
    expect(created.isbn).toBe("9789998887776");
    expect(created.copies).toHaveLength(1);
    expect(created.copies[0].format).toBe("OTHER");
  });

  it("matches multiple shelf items against the same newly-created book within one sync run", async () => {
    mockShelfFetch(
      buildRssPage([
        { title: "Test Owned Physical Repeat Book", isbn13: "9781231231231" },
        { title: "Test Owned Physical Repeat Book" }, // same title, no isbn -- should fuzzy-match the one just created, not create a second row
      ]),
    );

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const matches = await prisma.book.findMany({
      where: { title: "Test Owned Physical Repeat Book" },
      include: { copies: true },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].copies).toHaveLength(1);
  });

  it("does not remove an existing copy when the shelf item is no longer present on a later sync", async () => {
    const existing = await prisma.book.create({
      data: { title: "Test Owned Physical Persistent Book" },
    });

    mockShelfFetch(buildRssPage([{ title: "Test Owned Physical Persistent Book" }]));
    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    // Second sync: the shelf is now empty (book removed from shelf on Goodreads).
    mockShelfFetch(EMPTY_RSS_PAGE);
    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1); // still there
  });

  it("defaults to the owned-physical shelf when no shelf name is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);
    global.fetch = fetchMock;

    await syncOwnedPhysicalBooks("1993628");

    expect(DEFAULT_OWNED_PHYSICAL_SHELF).toBe("owned-physical");
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("shelf")).toBe("owned-physical");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/ownedPhysicalSync.test.ts`
Expected: FAIL — `src/lib/ownedPhysicalSync.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/lib/ownedPhysicalSync.ts`**

```typescript
import { prisma } from "@/lib/prisma";
import { findBestTitleMatch } from "@/lib/matching";
import { fetchAllGoodreadsBooks, type GoodreadsBook } from "@/lib/goodreadsSync";

export const DEFAULT_OWNED_PHYSICAL_SHELF = "owned-physical";

interface OwnedPhysicalCandidate {
  id: string;
  title: string;
  isbn: string | null;
  copiesCount: number;
}

const CANDIDATE_SELECT = {
  id: true,
  title: true,
  isbn: true,
  _count: { select: { copies: true } },
} as const;

function toCandidate(book: {
  id: string;
  title: string;
  isbn: string | null;
  _count: { copies: number };
}): OwnedPhysicalCandidate {
  return { id: book.id, title: book.title, isbn: book.isbn, copiesCount: book._count.copies };
}

// Attaches a placeholder physical copy (format: "OTHER", since Goodreads has
// no concept of hardcover/paperback/etc.) to an existing Book matched by
// ISBN or fuzzy title -- or creates a new Book + copy when nothing matches.
// Never overwrites the matched book's title/author/isbn (same safeguard
// every other fuzzy-match-then-attach path in this codebase uses), and
// never adds a second copy to a book that already has one -- see the design
// spec's Scope section for why (no way to tell a sync-created copy apart
// from a user-entered one, so this sync only ever adds, never removes).
async function applyShelfItem(
  item: GoodreadsBook,
  candidates: OwnedPhysicalCandidate[],
): Promise<void> {
  let match: OwnedPhysicalCandidate | null = null;

  if (item.isbn) {
    // `candidates` is fetched with `orderBy: createdAt asc`, so the first
    // array match is deterministically the oldest -- same rule
    // createBookWithCopyData's ISBN branch uses for the same reason
    // (Book.isbn has no unique constraint).
    match = candidates.find((c) => c.isbn === item.isbn) ?? null;
  }
  if (!match) {
    match = findBestTitleMatch(candidates, item.title);
  }

  if (match) {
    if (match.copiesCount > 0) return;
    await prisma.physicalCopy.create({ data: { bookId: match.id, format: "OTHER" } });
    match.copiesCount += 1;
    return;
  }

  const created = await prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      isbn: item.isbn,
      copies: { create: { format: "OTHER" } },
    },
    select: CANDIDATE_SELECT,
  });
  candidates.push(toCandidate(created));
}

// Syncs the user's "owned-physical" (or custom-configured) Goodreads shelf
// onto the catalog -- see
// docs/superpowers/specs/2026-07-16-owned-physical-goodreads-sync-design.md.
// Runs independently of syncGoodreadsTbr; only ever adds Book/PhysicalCopy
// rows, never removes them.
export async function syncOwnedPhysicalBooks(
  userId: string,
  shelfName: string = DEFAULT_OWNED_PHYSICAL_SHELF,
): Promise<{ synced: number }> {
  const items = await fetchAllGoodreadsBooks(userId, shelfName);

  const books = await prisma.book.findMany({
    select: CANDIDATE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const candidates: OwnedPhysicalCandidate[] = books.map(toCandidate);

  for (const item of items) {
    await applyShelfItem(item, candidates);
  }

  return { synced: items.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/ownedPhysicalSync.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ownedPhysicalSync.ts src/lib/ownedPhysicalSync.test.ts
git commit -m "feat: sync the owned-physical Goodreads shelf into Book/PhysicalCopy rows"
```

---

## Task 3: Wire Into the Cron Job and "Refresh Now" Route

**Files:**
- Modify: `src/instrumentation.ts`
- Modify: `src/app/api/sync/goodreads/route.ts`

- [ ] **Step 1: Add the sync to the scheduled cron job**

In `src/instrumentation.ts`, add the import alongside the existing ones:

```typescript
  const { syncGoodreadsTbr } = await import("@/lib/goodreadsSync");
  const { syncOwnedPhysicalBooks } = await import("@/lib/ownedPhysicalSync");
```

Then update the Goodreads `cron.schedule` block to also run the new sync, independently (its own `try`/`catch`, so a failure in one never prevents the other from running):

```typescript
  cron.schedule(
    "*/30 * * * *",
    async () => {
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
      try {
        const shelfName = process.env.GOODREADS_OWNED_PHYSICAL_SHELF || undefined;
        const result = await syncOwnedPhysicalBooks(userId, shelfName);
        console.log(`Scheduled owned-physical sync: ${result.synced} items synced`);
      } catch (error) {
        console.error("Scheduled owned-physical sync failed:", error);
      }
    },
    { noOverlap: true },
  );
```

- [ ] **Step 2: Add the sync to the manual "Refresh now" route**

Replace the entire contents of `src/app/api/sync/goodreads/route.ts` with:

```typescript
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { syncGoodreadsTbr } from "@/lib/goodreadsSync";
import { syncOwnedPhysicalBooks } from "@/lib/ownedPhysicalSync";
import { TBR_GAP_CACHE_TAG } from "@/lib/tbrGap";

export async function POST() {
  const userId = process.env.GOODREADS_USER_ID;

  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Server misconfigured: GOODREADS_USER_ID not set" },
      { status: 500 },
    );
  }

  let synced = 0;
  const errors: string[] = [];

  try {
    const result = await syncGoodreadsTbr(userId);
    synced += result.synced;
    // TBR list changed; bust the cached TBR gap computation immediately so
    // the next /tbr load reflects the new sync results instead of serving
    // stale data for up to the 30-minute safety window.
    revalidateTag(TBR_GAP_CACHE_TAG, { expire: 0 });
  } catch (error) {
    console.error("Goodreads sync failed:", error);
    errors.push(error instanceof Error ? error.message : "Goodreads sync failed");
  }

  try {
    const shelfName = process.env.GOODREADS_OWNED_PHYSICAL_SHELF || undefined;
    const result = await syncOwnedPhysicalBooks(userId, shelfName);
    synced += result.synced;
  } catch (error) {
    console.error("Owned-physical sync failed:", error);
    errors.push(error instanceof Error ? error.message : "Owned-physical sync failed");
  }

  if (errors.length > 0) {
    return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 502 });
  }
  return NextResponse.json({ success: true, synced });
}
```

This keeps the response shape (`{ success, synced, error? }`) exactly what `RefreshSyncButton.tsx` already expects — no UI changes needed. Both syncs are always attempted regardless of whether the other succeeds; `synced` is the combined count on full success, and any failure(s) produce a combined error message.

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/instrumentation.ts src/app/api/sync/goodreads/route.ts
git commit -m "feat: run the owned-physical Goodreads sync alongside the existing Goodreads sync"
```

---

## Task 4: Final Verification Pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including every file touched above.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: production build succeeds.

- [ ] **Step 5: Note remaining manual step**

Live verification (matching every prior phase's pattern) can't be done from this sandbox: after this branch is deployed, trigger a real sync (cron or "Refresh now") and confirm real `owned-physical`-tagged books not yet in the catalog get created with a placeholder `OTHER`-format copy, books already scanned are left untouched (no duplicate copy), and the existing to-read/read-status sync is unaffected. Flag this to the user rather than marking it done — it requires the real deployed app and the real Goodreads account.
