# Cover-Fetch Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `backfillAbsCovers`' ebook-before-audiobook starvation (backlog #10), and distinguish two cover-fetch failure classes — ISBN drift and unsupported image format — from genuine "no cover exists" (backlog #11).

**Architecture:** A schema migration adds `coverFetchFailureReason` (nullable string) to the three cover-tracking tables. A new `UnsupportedCoverFormatError` class makes the format-unsupported case distinguishable at its source (`coverStorage.ts`), threaded through both cover-fetch call paths (`saveCoverFromUrl` for TBR/Open Library, `fetchAbsCoverAndSave` for ABS) so their callers can record the distinction without changing retry cadence. Separately, `reconcileTbrItems` resets the cover-check gate when a matched row's ISBN changes. `backfillAbsCovers`' ebook/audiobook candidate lists are merged by round-robin interleaving instead of concatenation.

**Tech Stack:** TypeScript, Prisma (migration), Vitest with a real isolated Postgres test DB.

---

## Design spec

Full rationale: `docs/superpowers/specs/2026-07-19-cover-fetch-robustness-design.md`. Read it before starting.

## Task 1: Schema migration — add coverFetchFailureReason

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a new migration under `prisma/migrations/` (auto-generated, do not hand-write the SQL)

- [ ] **Step 1: Add the field to all three models**

In `prisma/schema.prisma`, add `coverFetchFailureReason String?` immediately after `coverCheckedAt DateTime?` in each of these three models:

```prisma
model EbookCopy {
  id                      String    @id @default(cuid())
  bookId                  String
  book                    Book      @relation(fields: [bookId], references: [id])
  absItemId               String    @unique
  coverImagePath          String?
  coverCheckedAt          DateTime?
  coverFetchFailureReason String?
  createdAt               DateTime  @default(now())
}

model AudiobookCopy {
  id                      String    @id @default(cuid())
  bookId                  String
  book                    Book      @relation(fields: [bookId], references: [id])
  absItemId               String    @unique
  coverImagePath          String?
  coverCheckedAt          DateTime?
  coverFetchFailureReason String?
  createdAt               DateTime  @default(now())
}

model GoodreadsTbrItem {
  id                      String    @id @default(cuid())
  title                   String
  author                  String?
  isbn                    String?
  coverImagePath          String?
  coverCheckedAt          DateTime?
  coverFetchFailureReason String?
  lastSyncedAt            DateTime  @default(now())
}
```

(Only the new `coverFetchFailureReason` line is added to each model — every other field stays exactly as it is today; the blocks above are shown in full only so the field's exact position is unambiguous.)

- [ ] **Step 2: Generate and apply the migration to the dev database**

Run: `npx prisma migrate dev --name add_cover_fetch_failure_reason`

This applies the migration to whatever `DATABASE_URL` is configured in `.env` (the dev database) and generates the migration SQL file under `prisma/migrations/`.

- [ ] **Step 3: Apply the migration to the isolated test database**

Run (using this worktree's actual `.env.test` `DATABASE_URL` value — read `.env.test` first to get the exact connection string):

```bash
DATABASE_URL="<paste .env.test's DATABASE_URL value here>" npx prisma migrate deploy
```

This matches the documented workflow in `README.md`'s "Running tests" section. Without this step, every test in this plan will fail with a Prisma schema-mismatch error against the test database.

- [ ] **Step 4: Verify Prisma Client regenerated correctly**

Run: `npx tsc --noEmit`

Expected: clean (confirms the generated Prisma Client types now include `coverFetchFailureReason` on all three models — `postinstall` already runs `prisma generate`, but `prisma migrate dev` also regenerates it automatically).

- [ ] **Step 5: Run the full test suite to confirm nothing broke**

Run: `npm test`

Expected: all existing tests still pass (this step only adds a nullable column — no existing behavior changes yet).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add coverFetchFailureReason to cover-tracking tables

Nullable, free-form string field on GoodreadsTbrItem/EbookCopy/
AudiobookCopy. First step toward distinguishing an unsupported-image-
format cover-fetch failure from a genuine 'no cover exists' outcome --
both currently look identical (coverCheckedAt set, coverImagePath
null). No behavior change yet; later tasks populate and read this
field."
```

## Task 2: UnsupportedCoverFormatError in coverStorage.ts

**Files:**
- Modify: `src/lib/coverStorage.ts`
- Test: `src/lib/coverStorage.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/coverStorage.test.ts`, replace the existing `"rejects a data URL with an unsupported mime type"` test (around line 30) with:

```typescript
  it("rejects a data URL with an unsupported mime type, throwing UnsupportedCoverFormatError specifically", async () => {
    const dataUrl = "data:text/plain;base64,aGVsbG8=";
    await expect(saveCoverImage(dataUrl)).rejects.toThrow(/unsupported image type/i);
    await expect(saveCoverImage(dataUrl)).rejects.toBeInstanceOf(UnsupportedCoverFormatError);
  });

  it("throws a plain Error, not UnsupportedCoverFormatError, for a malformed data URL", async () => {
    let caught: unknown;
    try {
      await saveCoverImage("not-a-data-url");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnsupportedCoverFormatError);
  });

  it("throws a plain Error, not UnsupportedCoverFormatError, for an oversized payload", async () => {
    const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
    const dataUrl = `data:image/png;base64,${oversizedBuffer.toString("base64")}`;
    let caught: unknown;
    try {
      await saveCoverImage(dataUrl);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnsupportedCoverFormatError);
  });
```

Delete the old `"rejects a malformed data URL"` and `"rejects a payload larger than the max cover image size"` tests (around lines 35-45) — their message-based assertions are now covered by (and superseded by) the two new instanceof-based tests above, which additionally verify the class distinction.

Add the import at the top of the file: `import { deleteCoverImage, saveCoverImage, UnsupportedCoverFormatError } from "@/lib/coverStorage";` (replacing the existing import line that doesn't include `UnsupportedCoverFormatError`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/coverStorage.test.ts`

Expected: FAIL — `UnsupportedCoverFormatError` doesn't exist yet, so this is a TypeScript/import error (the whole file fails to run).

- [ ] **Step 3: Add UnsupportedCoverFormatError and throw it**

In `src/lib/coverStorage.ts`, add this new exported class near the top of the file (after the existing imports, before `UPLOADS_DIR`):

```typescript
// Thrown specifically for the "image format we don't save" case, distinct
// from the generic Error thrown for a malformed data URL or an oversized
// payload -- callers (saveCoverFromUrl, fetchAbsCoverAndSave) catch this
// specifically so a cover that WAS found, just in an unsaveable format, can
// be recorded differently from a genuine "no cover exists" outcome. See
// docs/superpowers/specs/2026-07-19-cover-fetch-robustness-design.md.
export class UnsupportedCoverFormatError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported image type: ${mimeType}`);
    this.name = "UnsupportedCoverFormatError";
  }
}
```

Then change the existing throw inside `saveCoverImage`:

```typescript
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new UnsupportedCoverFormatError(mimeType);
  }
```

(This replaces `throw new Error(\`Unsupported image type: ${mimeType}\`);` — same message, different class.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/coverStorage.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/lib/coverStorage.ts src/lib/coverStorage.test.ts`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/coverStorage.ts src/lib/coverStorage.test.ts
git commit -m "feat: add UnsupportedCoverFormatError, thrown specifically for format gaps

Distinguishes 'cover found, but in a format saveCoverImage doesn't
accept' from the generic Error thrown for a malformed data URL or an
oversized payload. Callers will catch this specifically in the next
task to record the distinction instead of treating it identically to
a genuine not-found outcome."
```

## Task 3: Propagate the format-gap distinction through both fetch paths

**Files:**
- Modify: `src/lib/books.ts` (`saveCoverFromUrl`)
- Modify: `src/lib/absSync.ts` (`fetchAbsCoverAndSave`, `backfillAbsCovers`)
- Modify: `src/lib/goodreadsSync.ts` (`fetchMissingTbrCovers`)
- Test: `src/lib/books.test.ts`, `src/lib/absSync.test.ts`, `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing test for saveCoverFromUrl**

In `src/lib/books.test.ts`, inside `describe("saveCoverFromUrl", ...)`, add this test right after the existing `"saves the image when fetched from the Open Library covers host"` test:

```typescript
  it("returns reason: 'unsupported_format' when the fetched cover's content-type isn't saveable", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/gif" }),
      arrayBuffer: async () => Buffer.from("not-really-a-gif"),
    } as unknown as Response);

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({
      error: "Unsupported cover image format",
      reason: "unsupported_format",
    });
  });

  it("does not set reason on a plain fetch failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Failed to fetch cover image" });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/books.test.ts -t "unsupported_format|does not set reason"`

Expected: FAIL — `saveCoverFromUrl` doesn't return a `reason` field yet, and the GIF case currently returns the generic `{ error: "Failed to fetch cover image" }` from the catch-all instead of the format-specific message.

- [ ] **Step 3: Update saveCoverFromUrl**

In `src/lib/books.ts`, change the return type and catch block. First, update the function signature:

```typescript
export async function saveCoverFromUrl(
  url: string,
): Promise<{ coverImagePath: string } | { error: string; reason?: "unsupported_format" }> {
```

Then update the `catch` block at the end of the function (currently `catch { return { error: "Failed to fetch cover image" }; }`):

```typescript
  } catch (err) {
    if (err instanceof UnsupportedCoverFormatError) {
      return { error: "Unsupported cover image format", reason: "unsupported_format" };
    }
    return { error: "Failed to fetch cover image" };
  }
}
```

Add the import: `import { saveCoverImage, UnsupportedCoverFormatError } from "@/lib/coverStorage";` (update the existing `saveCoverImage` import line in `src/lib/books.ts` to also bring in `UnsupportedCoverFormatError`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/books.test.ts`

Expected: all tests in this file pass.

- [ ] **Step 5: Write the failing test for fetchAbsCoverAndSave / backfillAbsCovers**

In `src/lib/absSync.test.ts`, inside `describe("syncAbsCache", ...)`, add this test right after the existing `"sets coverCheckedAt without a coverImagePath when the ABS cover endpoint returns a non-OK response"` test:

```typescript
  it("sets coverFetchFailureReason when the ABS cover is in an unsupported format", async () => {
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Unsupported Cover Format",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "backfill-unsupported-format" } },
      },
    });

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/libraries")) {
        return { ok: true, json: async () => ({ libraries: [] }) } as Response;
      }
      if (url.includes("/api/items/backfill-unsupported-format/cover")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/gif" }),
          arrayBuffer: async () => Buffer.from("not-really-a-gif"),
        } as unknown as Response;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof global.fetch;

    await syncAbsCache("https://abs.example.com", "token");

    const updated = await prisma.ebookCopy.findFirstOrThrow({
      where: { absItemId: "backfill-unsupported-format" },
    });
    expect(updated.coverImagePath).toBeNull();
    expect(updated.coverCheckedAt).not.toBeNull();
    expect(updated.coverFetchFailureReason).toBe("unsupported_format");
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/lib/absSync.test.ts -t "unsupported format"`

Expected: FAIL — `coverFetchFailureReason` isn't being set yet (`fetchAbsCoverAndSave` still swallows the throw into a plain `null`).

- [ ] **Step 7: Update fetchAbsCoverAndSave and backfillAbsCovers**

In `src/lib/absSync.ts`, change `fetchAbsCoverAndSave`'s return type and body:

```typescript
async function fetchAbsCoverAndSave(
  baseUrl: string,
  token: string,
  absItemId: string,
): Promise<{ coverImagePath: string } | { reason?: "unsupported_format" }> {
  try {
    const response = await fetch(`${baseUrl}/api/items/${absItemId}/cover`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return {};

    const arrayBuffer = await response.arrayBuffer();
    const rawContentType = response.headers.get("content-type") ?? "image/jpeg";
    const contentType = rawContentType.split(";")[0].trim();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const coverImagePath = await saveCoverImage(`data:${contentType};base64,${base64}`);
    return { coverImagePath };
  } catch (err) {
    if (err instanceof UnsupportedCoverFormatError) {
      return { reason: "unsupported_format" };
    }
    return {};
  }
}
```

Then update `backfillAbsCovers`'s loop (the part that calls `fetchAbsCoverAndSave` and builds the update `data`):

```typescript
  for (const copy of pending) {
    const result = await fetchAbsCoverAndSave(baseUrl, token, copy.absItemId);
    const data = {
      coverCheckedAt: new Date(),
      ...("coverImagePath" in result
        ? { coverImagePath: result.coverImagePath, coverFetchFailureReason: null }
        : { coverFetchFailureReason: result.reason ?? null }),
    };
    if (copy.table === "ebook") {
      await prisma.ebookCopy.update({ where: { id: copy.id }, data });
    } else {
      await prisma.audiobookCopy.update({ where: { id: copy.id }, data });
    }
  }
```

Add the import: `import { saveCoverImage, UnsupportedCoverFormatError } from "@/lib/coverStorage";` (update the existing `saveCoverImage` import line in `src/lib/absSync.ts`).

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/lib/absSync.test.ts`

Expected: all tests in this file pass, including the two pre-existing cover-backfill tests (which must still pass unmodified — `fetchAbsCoverAndSave`'s new return shape is handled transparently by the updated loop).

- [ ] **Step 9: Write the failing test for fetchMissingTbrCovers**

In `src/lib/goodreadsSync.test.ts`, find the existing `it("caps the number of cover fetches attempted in a single sync run", ...)` test (search for it) and add this new test right after it:

```typescript
  it("sets coverFetchFailureReason when the TBR item's cover is in an unsupported format", async () => {
    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: "https://covers.openlibrary.org/b/isbn/9780000000099-M.jpg",
    });
    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync Unsupported Cover Format", isbn13: "9780000000099" },
        ]),
      ],
    });
    // mockShelfFetch installs the RSS-serving fetch mock FIRST -- capture
    // that as the delegate before layering the cover-request interceptor on
    // top, so shelf requests still resolve correctly. This mirrors the
    // existing "fetches and stores a cover for a new TBR item that has an
    // ISBN" test's wrapping pattern -- the item must arrive via the shelf
    // feed itself (not a direct prisma.create), since reconcileTbrItems
    // deletes any pre-existing row that isn't matched on the incoming shelf
    // before fetchMissingTbrCovers ever runs.
    const rssFetch = global.fetch;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("covers.openlibrary.org")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/gif" }),
          arrayBuffer: async () => Buffer.from("not-really-a-gif"),
        } as unknown as Response;
      }
      return rssFetch(input as never);
    }) as typeof global.fetch;

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.goodreadsTbrItem.findFirstOrThrow({
      where: { title: "Test Goodreads Sync Unsupported Cover Format" },
    });
    expect(updated.coverImagePath).toBeNull();
    expect(updated.coverCheckedAt).not.toBeNull();
    expect(updated.coverFetchFailureReason).toBe("unsupported_format");
  });
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "unsupported format"`

Expected: FAIL — `coverFetchFailureReason` isn't being set yet.

- [ ] **Step 11: Update fetchMissingTbrCovers**

In `src/lib/goodreadsSync.ts`, update the loop inside `fetchMissingTbrCovers`:

```typescript
  for (const item of pending) {
    const lookup = await lookupIsbn(item.isbn!);
    let coverImagePath: string | undefined;
    let failureReason: "unsupported_format" | null = null;
    if (lookup.coverUrl) {
      const result = await saveCoverFromUrl(lookup.coverUrl);
      if ("error" in result) {
        failureReason = result.reason ?? null;
      } else {
        coverImagePath = result.coverImagePath;
      }
    }
    await prisma.goodreadsTbrItem.update({
      where: { id: item.id },
      data: {
        coverCheckedAt: new Date(),
        coverFetchFailureReason: failureReason,
        ...(coverImagePath ? { coverImagePath } : {}),
      },
    });
  }
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`

Expected: all tests in this file pass, including every pre-existing cover-fetch test.

- [ ] **Step 13: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/lib/books.ts src/lib/books.test.ts src/lib/absSync.ts src/lib/absSync.test.ts src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 14: Commit**

```bash
git add src/lib/books.ts src/lib/books.test.ts src/lib/absSync.ts src/lib/absSync.test.ts src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "feat: record unsupported-format cover-fetch failures distinctly

saveCoverFromUrl and fetchAbsCoverAndSave now catch
UnsupportedCoverFormatError specifically and surface it as
reason: 'unsupported_format', which fetchMissingTbrCovers and
backfillAbsCovers record in the new coverFetchFailureReason column.
Retry cadence is unchanged (coverCheckedAt is still set unconditionally
after every attempt) -- this only makes these rows identifiable
(WHERE coverFetchFailureReason = 'unsupported_format') for future
manual/scripted remediation if coverStorage.ts's supported formats
ever expand, rather than being indistinguishable from a genuine
not-found outcome."
```

## Task 4: Interleave ebook/audiobook backfill

**Files:**
- Modify: `src/lib/absSync.ts` (`backfillAbsCovers`)
- Test: `src/lib/absSync.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/absSync.test.ts`, inside `describe("syncAbsCache", ...)`, add this test right after the `"never re-attempts a cover fetch once coverCheckedAt is set"` test:

```typescript
  it("interleaves ebook and audiobook cover backfill instead of draining ebooks first", async () => {
    // 30 ebook copies missing covers (more than ABS_COVER_FETCH_CAP's 25) and
    // 1 audiobook copy missing one. Under the old concatenate-then-slice
    // behavior, the audiobook candidate would never be reached (the first
    // 25 slots are entirely ebooks). Interleaving must give it a slot.
    const book = await prisma.book.create({
      data: { title: "Test Abs Sync Interleave Backfill Book", hasEbook: true, hasAudiobook: true },
    });
    for (let i = 0; i < 30; i++) {
      await prisma.ebookCopy.create({
        data: { bookId: book.id, absItemId: `interleave-ebook-${i}` },
      });
    }
    await prisma.audiobookCopy.create({
      data: { bookId: book.id, absItemId: "interleave-audiobook-1" },
    });

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/libraries")) {
        return { ok: true, json: async () => ({ libraries: [] }) } as Response;
      }
      // Every cover request "succeeds" with a 404 -- this test only cares
      // about which absItemIds get REQUESTED, not what comes back.
      return { ok: false, status: 404 } as Response;
    }) as typeof global.fetch;

    await syncAbsCache("https://abs.example.com", "token");

    const updatedAudiobook = await prisma.audiobookCopy.findUniqueOrThrow({
      where: { absItemId: "interleave-audiobook-1" },
    });
    expect(updatedAudiobook.coverCheckedAt).not.toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/absSync.test.ts -t "interleaves ebook and audiobook"`

Expected: FAIL — `updatedAudiobook.coverCheckedAt` is `null` (the 30 ebook candidates fill the entire 25-item cap before the audiobook candidate is ever considered).

- [ ] **Step 3: Implement interleaving**

In `src/lib/absSync.ts`, replace the `pending` construction in `backfillAbsCovers` (currently the concatenate-then-slice, right after the `Promise.all` fetching `missingEbookCovers`/`missingAudiobookCovers`):

```typescript
  // Interleaved (not concatenated-then-sliced) so a large backlog in one
  // media type can't starve the other of any attempts this run -- each
  // type gets roughly half the per-run budget when both have a backlog.
  const pending: { table: "ebook" | "audiobook"; id: string; absItemId: string }[] = [];
  for (
    let i = 0;
    pending.length < ABS_COVER_FETCH_CAP &&
    (i < missingEbookCovers.length || i < missingAudiobookCovers.length);
    i++
  ) {
    if (i < missingEbookCovers.length && pending.length < ABS_COVER_FETCH_CAP) {
      pending.push({ table: "ebook", ...missingEbookCovers[i] });
    }
    if (i < missingAudiobookCovers.length && pending.length < ABS_COVER_FETCH_CAP) {
      pending.push({ table: "audiobook", ...missingAudiobookCovers[i] });
    }
  }
```

This replaces the old:
```typescript
  const pending = [
    ...missingEbookCovers.map((c) => ({ table: "ebook" as const, id: c.id, absItemId: c.absItemId })),
    ...missingAudiobookCovers.map((c) => ({
      table: "audiobook" as const,
      id: c.id,
      absItemId: c.absItemId,
    })),
  ].slice(0, ABS_COVER_FETCH_CAP);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/absSync.test.ts`

Expected: all tests in this file pass, including the pre-existing backfill tests (a single missing ebook or single missing audiobook, with nothing to interleave against, behaves identically to before).

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/lib/absSync.ts src/lib/absSync.test.ts`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/absSync.ts src/lib/absSync.test.ts
git commit -m "fix: interleave ebook/audiobook cover backfill instead of draining ebooks first

backfillAbsCovers fetched up to ABS_COVER_FETCH_CAP missing-cover
ebooks AND up to that same cap missing-cover audiobooks independently,
then concatenated ebooks-then-audiobooks and sliced to the cap -- since
each sub-query was already capped, a library with >=25 missing ebook
covers filled the entire budget with ebooks alone, starving audiobook
backfill until the ebook backlog dropped below the cap. Round-robin
interleaving gives each media type roughly half the per-run budget
when both have a backlog."
```

## Task 5: Reset the cover-check gate on ISBN drift

**Files:**
- Modify: `src/lib/goodreadsSync.ts` (`reconcileTbrItems`)
- Test: `src/lib/goodreadsSync.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/lib/goodreadsSync.test.ts`, inside `describe("syncGoodreadsTbr", ...)`, add this test right after the existing `"recovers an existing ISBN-bearing row by exact title match when its incoming ISBN no longer matches"` test (search for it to find the exact location — around line 613-636; note that existing test already covers the exact-title-match-despite-ISBN-mismatch mechanism and asserts `coverImagePath` is preserved, but it does NOT touch `coverCheckedAt` at all, which is what these two new tests add coverage for). Use fixture titles distinct from that existing test's `"Test Goodreads Sync Isbn Drift Book"` to avoid confusion between tests:

```typescript
  it("resets coverCheckedAt when a matched row's isbn changes and it has no cover yet", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Isbn Drift Cover Reset Book",
        isbn: "9780000000001",
        coverCheckedAt: new Date(), // already checked-and-failed under the OLD isbn
        coverFetchFailureReason: null,
      },
    });

    vi.mocked(lookupIsbn).mockResolvedValue({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
    mockShelfFetch({
      "to-read": [
        // Same title, corrected isbn -- exact-title match, not fuzzy.
        buildRssPage([
          { title: "Test Goodreads Sync Isbn Drift Cover Reset Book", isbn13: "9780000000002" },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.isbn).toBe("9780000000002");
    expect(updated.coverCheckedAt).toBeNull();
  });

  it("does not reset coverCheckedAt when isbn changes on a row that already has a cover", async () => {
    const existing = await prisma.goodreadsTbrItem.create({
      data: {
        title: "Test Goodreads Sync Isbn Drift Existing Cover Book",
        isbn: "9780000000003",
        coverImagePath: "already-has-a-cover.jpg",
        coverCheckedAt: new Date(),
      },
    });

    mockShelfFetch({
      "to-read": [
        buildRssPage([
          { title: "Test Goodreads Sync Isbn Drift Existing Cover Book", isbn13: "9780000000004" },
        ]),
      ],
    });

    await syncGoodreadsTbr("1993628");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: existing.id } });
    expect(updated.isbn).toBe("9780000000004");
    expect(updated.coverCheckedAt).not.toBeNull(); // untouched -- already has a cover
    expect(updated.coverImagePath).toBe("already-has-a-cover.jpg");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/goodreadsSync.test.ts -t "isbn drift"`

Expected: the first test FAILs (`updated.coverCheckedAt` is still set, not reset). The second test should already PASS (nothing resets `coverCheckedAt` today, which happens to match "don't touch it" for the has-cover case) — that's fine, it's there as a regression guard for the upcoming change, not meant to fail first.

- [ ] **Step 3: Implement the reset**

In `src/lib/goodreadsSync.ts`, inside `reconcileTbrItems`'s matched-row branch, update the block that calls `prisma.goodreadsTbrItem.update` when the shelf item's data differs from the matched row:

```typescript
    if (matched) {
      matchedIds.add(matched.id);
      const isbnChanged = matched.isbn !== shelfItem.isbn;
      if (
        matched.title !== shelfItem.title ||
        matched.author !== shelfItem.author ||
        isbnChanged
      ) {
        await prisma.goodreadsTbrItem.update({
          where: { id: matched.id },
          data: {
            title: shelfItem.title,
            author: shelfItem.author,
            isbn: shelfItem.isbn,
            // A corrected isbn deserves a fresh cover-fetch attempt -- the
            // previous attempt (if any) used the OLD, now-stale isbn.
            // Only relevant when there's no cover yet; harmless no-op
            // otherwise (coverCheckedAt may already be null, or the row
            // already has a cover and the "pending" query for
            // fetchMissingTbrCovers never considers rows with one).
            ...(isbnChanged && matched.coverImagePath === null
              ? { coverCheckedAt: null, coverFetchFailureReason: null }
              : {}),
          },
        });
      }
    }
```

This replaces the existing:
```typescript
    if (matched) {
      matchedIds.add(matched.id);
      if (
        matched.title !== shelfItem.title ||
        matched.author !== shelfItem.author ||
        matched.isbn !== shelfItem.isbn
      ) {
        await prisma.goodreadsTbrItem.update({
          where: { id: matched.id },
          data: { title: shelfItem.title, author: shelfItem.author, isbn: shelfItem.isbn },
        });
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/goodreadsSync.test.ts`

Expected: all tests in this file pass, including every pre-existing `reconcileTbrItems`/`syncGoodreadsTbr` test (title/author-only changes, and isbn changes on a row that ALREADY has a cover, must behave exactly as before).

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goodreadsSync.ts src/lib/goodreadsSync.test.ts
git commit -m "fix: reset the cover-check gate when a TBR row's isbn drifts

If a TBR item's cover-fetch already failed using its isbn at the time,
and a later sync corrects that row's isbn via reconcileTbrItems' fuzzy-
match reconciliation, the corrected isbn was never looked up --
coverCheckedAt from the old, now-stale isbn's failed attempt still
blocked it. Now reset alongside the isbn update, but only when the row
has no cover yet (a no-op otherwise, whether because coverCheckedAt is
already null or because the row already has a cover)."
```

## Task 6: Integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests passing.

- [ ] **Step 2: Typecheck and lint the whole project**

Run: `npx tsc --noEmit` and `npx eslint .`

Expected: both clean (aside from any pre-existing, unrelated findings — confirm any such finding predates this branch by checking it's not in a file this plan touched).

- [ ] **Step 3: Confirm the migration is present and applied**

Run: `npx prisma migrate status` (against `.env`'s dev DB) and separately against `.env.test`'s DB (`DATABASE_URL="<.env.test's value>" npx prisma migrate status`).

Expected: both report no pending migrations.

- [ ] **Step 4: Report findings**

If any check fails, fix it before considering this plan complete. If everything passes, this plan is done.

## Non-goals (do not implement)

- No automatic retry cadence for unsupported-format failures.
- No change to plain network-error/not-found handling.
- No change to the "too large" or "invalid data URL" `saveCoverImage` failure cases.
- No UI surfacing of `coverFetchFailureReason`.
- No change to `TBR_COVER_FETCH_CAP`/`ABS_COVER_FETCH_CAP`'s values.
