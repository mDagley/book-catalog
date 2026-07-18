# Orphaned Cover File Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deleting a copy (physical directly, or ebook/audiobook via a stale ABS sync removal) now also deletes its uploaded cover file from disk, instead of leaving it orphaned forever.

**Architecture:** Both deletion call sites already know (or can cheaply select) the copy's `coverImagePath` before deleting the row. Wire in the existing, already-best-effort `deleteCoverImage` helper (`src/lib/coverStorage.ts`, unchanged) right after each DB delete succeeds.

**Tech Stack:** Prisma, Vitest (real file I/O, matching this codebase's established cover-testing convention).

---

### Task 1: Clean up the cover file when a physical copy is deleted

**Files:**
- Modify: `src/lib/copies.ts`
- Modify: `src/lib/copies.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("deleteCopyData", ...)` block in `src/lib/copies.test.ts` (the file already imports `saveCoverImage`/`deleteCoverImage`/`readFile`/`path`/`uploadsDir` — add alongside the existing tests, don't remove anything):

```typescript
  it("deletes the cover file when the copy being removed has one", async () => {
    const bookId = await createTestBook();
    const addResult = await addCopyData(bookId, {
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    if ("error" in addResult) throw new Error("test setup failed");

    const ONE_PX_PNG_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const coverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    await prisma.physicalCopy.update({
      where: { id: addResult.copyId },
      data: { coverImagePath: coverPath },
    });

    await deleteCopyData(addResult.copyId);

    await expect(readFile(path.join(uploadsDir, coverPath))).rejects.toThrow();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/copies.test.ts -t "deletes the cover file when the copy being removed has one"`
Expected: FAIL — the file still exists after `deleteCopyData` returns, since nothing cleans it up yet.

- [ ] **Step 3: Update the implementation**

In `src/lib/copies.ts`, add the `deleteCoverImage` import and extend `deleteCopyData`:

```typescript
import { prisma } from "@/lib/prisma";
import { parseCopyFields } from "@/lib/books";
import { resolveCoverUpdate, type CoverSelectionInput } from "@/lib/copyCovers";
import { deleteCoverImage } from "@/lib/coverStorage";

export interface CopyFormState {
  error?: string;
}

interface CopyFieldsInput {
  format: string;
  publisher: string;
  publishYear: string;
  specialNotes: string;
}

export async function addCopyData(
  bookId: string,
  input: CopyFieldsInput,
): Promise<{ copyId: string } | { error: string }> {
  const parsed = parseCopyFields(input);
  if ("error" in parsed) {
    return parsed;
  }

  const copy = await prisma.physicalCopy.create({
    data: { bookId, ...parsed },
  });

  return { copyId: copy.id };
}

export async function updateCopyData(
  copyId: string,
  input: CopyFieldsInput & CoverSelectionInput,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseCopyFields(input);
  if ("error" in parsed) {
    return parsed;
  }

  const existing = await prisma.physicalCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { coverImagePath: true },
  });

  const coverResult = await resolveCoverUpdate(input, existing.coverImagePath);
  if ("error" in coverResult) {
    return coverResult;
  }

  await prisma.physicalCopy.update({
    where: { id: copyId },
    data: { ...parsed, coverImagePath: coverResult.coverImagePath },
  });

  return { ok: true };
}

export async function deleteCopyData(
  copyId: string,
): Promise<{ bookId: string; bookDeleted: boolean }> {
  const copy = await prisma.physicalCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { bookId: true, coverImagePath: true },
  });

  await prisma.physicalCopy.delete({ where: { id: copyId } });

  if (copy.coverImagePath) {
    await deleteCoverImage(copy.coverImagePath);
  }

  const remaining = await prisma.physicalCopy.count({ where: { bookId: copy.bookId } });

  if (remaining === 0) {
    const book = await prisma.book.findUniqueOrThrow({
      where: { id: copy.bookId },
      select: { hasEbook: true, hasAudiobook: true },
    });
    // A Book with an ebook or audiobook link is still owned even with its
    // last physical copy gone -- only delete when nothing (physical, ebook,
    // or audiobook) backs this row anymore.
    if (!book.hasEbook && !book.hasAudiobook) {
      await prisma.book.delete({ where: { id: copy.bookId } });
      return { bookId: copy.bookId, bookDeleted: true };
    }
  }

  return { bookId: copy.bookId, bookDeleted: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/copies.test.ts`
Expected: PASS (all existing tests + the new one)

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/copies.ts src/lib/copies.test.ts`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/lib/copies.ts src/lib/copies.test.ts
git commit -m "fix: delete a physical copy's cover file when the copy is deleted"
```

---

### Task 2: Clean up cover files when a stale ABS sync removes ebook/audiobook copies

**Files:**
- Modify: `src/lib/absSync.ts`
- Modify: `src/lib/absSync.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe("syncAbsCache", ...)` block in `src/lib/absSync.test.ts`. Also add the two new imports and one local constant at the top of the file (alongside the existing imports — don't remove anything):

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveCoverImage } from "@/lib/coverStorage";
```

```typescript
const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
```

(Place these near the existing `const originalFetch = global.fetch;` line.)

```typescript
  it("deletes the cover file when a stale ebook copy is removed", async () => {
    const coverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Stale Ebook Cover Cleanup",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-stale-ebook-cover-1", coverImagePath: coverPath } },
      },
    });

    mockLibrariesAndItems(
      {
        "ebook-lib": [
          {
            id: "test-stale-ebook-cover-other",
            media: { metadata: { title: "Test Abs Sync Stale Ebook Cover Unrelated" } },
          },
        ],
      },
      [{ id: "ebook-lib", name: "Panda EBooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    await expect(readFile(path.join(uploadsDir, coverPath))).rejects.toThrow();
  });

  it("deletes the cover file when a stale audiobook copy is removed", async () => {
    const coverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    await prisma.book.create({
      data: {
        title: "Test Abs Sync Stale Audiobook Cover Cleanup",
        hasAudiobook: true,
        audiobookCopies: {
          create: { absItemId: "test-stale-audiobook-cover-1", coverImagePath: coverPath },
        },
      },
    });

    mockLibrariesAndItems(
      {
        "audio-lib": [
          {
            id: "test-stale-audiobook-cover-other",
            media: { metadata: { title: "Test Abs Sync Stale Audiobook Cover Unrelated" } },
          },
        ],
      },
      [{ id: "audio-lib", name: "Panda Audiobooks" }],
    );

    await syncAbsCache("https://abs.example.com", "token");

    await expect(readFile(path.join(uploadsDir, coverPath))).rejects.toThrow();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/absSync.test.ts -t "deletes the cover file when a stale"`
Expected: FAIL — both cover files still exist after `syncAbsCache` returns, since nothing cleans them up yet.

- [ ] **Step 3: Update the implementation**

In `src/lib/absSync.ts`, add the `deleteCoverImage` import and extend `removeStaleAbsLinks`'s two branches:

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeIsbn } from "@/lib/books";
import { findBestTitleMatch } from "@/lib/matching";
import { deleteCoverImage } from "@/lib/coverStorage";
```

(This adds one new import line to the existing import block — everything else in the file above `removeStaleAbsLinks` is unchanged.)

```typescript
  if (syncedMediaTypes.has("EBOOK")) {
    const allEbookCopies = await prisma.ebookCopy.findMany({
      select: { id: true, bookId: true, absItemId: true, coverImagePath: true },
    });
    const staleEbookCopies = allEbookCopies.filter((c) => !seenItemIds.has(c.absItemId));
    if (staleEbookCopies.length > 0) {
      await prisma.ebookCopy.deleteMany({
        where: { id: { in: staleEbookCopies.map((c) => c.id) } },
      });
      for (const c of staleEbookCopies) {
        affectedBookIds.add(c.bookId);
        if (c.coverImagePath) {
          await deleteCoverImage(c.coverImagePath);
        }
      }
    }
  }

  if (syncedMediaTypes.has("AUDIOBOOK")) {
    const allAudiobookCopies = await prisma.audiobookCopy.findMany({
      select: { id: true, bookId: true, absItemId: true, coverImagePath: true },
    });
    const staleAudiobookCopies = allAudiobookCopies.filter((c) => !seenItemIds.has(c.absItemId));
    if (staleAudiobookCopies.length > 0) {
      await prisma.audiobookCopy.deleteMany({
        where: { id: { in: staleAudiobookCopies.map((c) => c.id) } },
      });
      for (const c of staleAudiobookCopies) {
        affectedBookIds.add(c.bookId);
        if (c.coverImagePath) {
          await deleteCoverImage(c.coverImagePath);
        }
      }
    }
  }
```

This replaces the existing two `if (syncedMediaTypes.has(...))` blocks in `removeStaleAbsLinks` — same structure, each `select` gains `coverImagePath`, and each `for` loop that already tracks `affectedBookIds` also calls `deleteCoverImage` for any stale copy that had one. Nothing else in `removeStaleAbsLinks` (the per-book count/update/delete logic below these two blocks) changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/absSync.test.ts`
Expected: PASS (all existing tests + the 2 new ones)

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/absSync.ts src/lib/absSync.test.ts`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/lib/absSync.ts src/lib/absSync.test.ts
git commit -m "fix: delete cover files when a stale ABS sync removes ebook/audiobook copies"
```

---

### Task 3: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the 3 new ones from Tasks 1–2.

- [ ] **Step 2: Full typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean (aside from the two pre-existing, unrelated issues noted throughout this project: a `set-state-in-effect` warning in `CoverPicker.tsx` and an unused-var warning in `src/lib/actions/copies.ts`).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds.

## Self-Review

**Spec coverage:** Both call sites named in the design spec's Implementation section are covered — Task 1 for `deleteCopyData`, Task 2 for `removeStaleAbsLinks`'s ebook and audiobook branches. Non-goals (retroactive cleanup, cover-editing flow changes) are untouched by both tasks.

**Placeholder scan:** No TBD/TODO markers; every step has complete, concrete code.

**Type consistency:** `deleteCoverImage` is imported and called identically (same signature, same best-effort semantics, no new error handling needed) in both Task 1 and Task 2 — no new types introduced.
