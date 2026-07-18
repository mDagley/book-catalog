# Copy Cover Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every copy type (physical, ebook, audiobook) have a cover image that can be added or replaced after the copy already exists, and make ebook/audiobook copies visible on the book detail page for the first time.

**Architecture:** A new shared helper (`resolveCoverUpdate`) centralizes "given new cover input and a copy's current cover, save the new file and clean up the old one" — reused by three separate, explicit per-copy-type update functions (extending the existing physical one, adding two new ones for ebook/audiobook). A new `<CoverEditor>` client component provides the shared file-upload/Open-Library-lookup/camera-capture UI, reused across three edit pages (extending the existing physical copy edit page, adding two new ones for ebook/audiobook). No schema changes — `coverImagePath` already exists on all three copy models.

**Tech Stack:** Next.js Server Actions, Prisma, Vitest (real file I/O for local saves, mocked `fetch` for URL-based saves — matching this project's existing `coverStorage.test.ts`/`books.test.ts` conventions).

---

### Task 1: Shared cover-resolution helper

**Files:**
- Create: `src/lib/copyCovers.ts`
- Test: `src/lib/copyCovers.test.ts`

This lives in its own new file (not inside `coverStorage.ts`) specifically to avoid a circular import: it needs `saveCoverFromUrl` from `src/lib/books.ts`, and `books.ts` itself already imports `saveCoverImage` from `coverStorage.ts` — so putting this helper inside `coverStorage.ts` would create `coverStorage.ts` → `books.ts` → `coverStorage.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/copyCovers.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveCoverUpdate } from "@/lib/copyCovers";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const originalFetch = global.fetch;
const savedPaths: string[] = [];

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
});

// 1x1 transparent PNG, same fixture coverStorage.test.ts uses.
const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("resolveCoverUpdate", () => {
  it("returns the current cover path unchanged when nothing is selected", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "", selectedCoverSource: undefined },
      "existing-cover.png",
    );
    expect(result).toEqual({ coverImagePath: "existing-cover.png" });
  });

  it("returns null unchanged when nothing is selected and there was no existing cover", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "", selectedCoverSource: undefined },
      null,
    );
    expect(result).toEqual({ coverImagePath: null });
  });

  it("saves a new data URL cover when there was no existing cover", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: ONE_PX_PNG_DATA_URL, selectedCoverSource: "dataUrl" },
      null,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath as string);
    expect(result.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
  });

  it("saves a new cover and deletes the old file when replacing an existing data URL cover", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);

    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: ONE_PX_PNG_DATA_URL, selectedCoverSource: "dataUrl" },
      oldPath,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath as string);

    expect(result.coverImagePath).not.toBe(oldPath);
    await expect(readFile(path.join(uploadsDir, oldPath))).rejects.toThrow();
  });

  it("returns an error for an invalid data URL without deleting the existing cover", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedPaths.push(oldPath);

    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "not-a-data-url", selectedCoverSource: "dataUrl" },
      oldPath,
    );

    expect(result).toEqual({ error: "Invalid cover image" });
    const stillThere = await readFile(path.join(uploadsDir, oldPath));
    expect(stillThere.length).toBeGreaterThan(0);
  });

  it("saves a new cover from a URL via saveCoverFromUrl", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () =>
        Buffer.from(ONE_PX_PNG_DATA_URL.split(",")[1], "base64").buffer,
    } as unknown as Response);

    const result = await resolveCoverUpdate(
      {
        selectedCoverDataUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg",
        selectedCoverSource: "url",
      },
      null,
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath as string);
  });

  it("returns an error when saveCoverFromUrl fails, without touching the existing cover", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedPaths.push(oldPath);
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

    const result = await resolveCoverUpdate(
      {
        selectedCoverDataUrl: "https://covers.openlibrary.org/b/id/99999-M.jpg",
        selectedCoverSource: "url",
      },
      oldPath,
    );

    expect(result).toEqual({ error: "Failed to fetch cover image" });
    const stillThere = await readFile(path.join(uploadsDir, oldPath));
    expect(stillThere.length).toBeGreaterThan(0);
  });

  it("returns an error for an unrecognized cover source", async () => {
    const result = await resolveCoverUpdate(
      { selectedCoverDataUrl: "something", selectedCoverSource: "bogus" },
      null,
    );
    expect(result).toEqual({ error: "Invalid cover selection" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/copyCovers.test.ts`
Expected: FAIL — `Cannot find module '@/lib/copyCovers'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/copyCovers.ts
import { saveCoverFromUrl } from "@/lib/books";
import { saveCoverImage, deleteCoverImage } from "@/lib/coverStorage";

// The two hidden-field names CoverPicker (and the new CoverEditor) submit:
// selectedCoverDataUrl holds either a base64 data URL (source "dataUrl") or
// a plain https URL (source "url") -- same naming CoverPicker already
// established; kept as-is here for consistency rather than renamed.
export interface CoverSelectionInput {
  selectedCoverDataUrl: string;
  selectedCoverSource: string | undefined;
}

// Given new cover selection input and a copy's current coverImagePath,
// resolves what the copy's coverImagePath should become: unchanged if
// nothing new was selected, or a freshly saved file (with the old one
// cleaned up, if there was one and it's being replaced). Mirrors the
// inline cover-resolution logic createBookFromScan (src/lib/actions/books.ts)
// already has for book creation, generalized to also handle replacing an
// existing cover -- book creation never has an "existing" cover to replace,
// so that logic never needed this.
export async function resolveCoverUpdate(
  input: CoverSelectionInput,
  currentCoverImagePath: string | null,
): Promise<{ coverImagePath: string | null } | { error: string }> {
  if (!input.selectedCoverDataUrl) {
    return { coverImagePath: currentCoverImagePath };
  }

  let coverImagePath: string;
  if (input.selectedCoverSource === "url") {
    const coverResult = await saveCoverFromUrl(input.selectedCoverDataUrl);
    if ("error" in coverResult) {
      return { error: coverResult.error };
    }
    coverImagePath = coverResult.coverImagePath;
  } else if (input.selectedCoverSource === "dataUrl") {
    try {
      coverImagePath = await saveCoverImage(input.selectedCoverDataUrl);
    } catch {
      return { error: "Invalid cover image" };
    }
  } else {
    return { error: "Invalid cover selection" };
  }

  if (currentCoverImagePath && currentCoverImagePath !== coverImagePath) {
    await deleteCoverImage(currentCoverImagePath);
  }

  return { coverImagePath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/copyCovers.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/copyCovers.ts src/lib/copyCovers.test.ts`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/lib/copyCovers.ts src/lib/copyCovers.test.ts
git commit -m "feat: add shared cover-resolution helper for copy editing"
```

---

### Task 2: Ebook copy cover update (lib + action)

**Files:**
- Create: `src/lib/ebookCopies.ts`
- Test: `src/lib/ebookCopies.test.ts`
- Create: `src/lib/actions/ebookCopies.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/ebookCopies.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { updateEbookCopyCoverData } from "@/lib/ebookCopies";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const savedPaths: string[] = [];

afterEach(async () => {
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
  await prisma.ebookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Ebook Copy Cover" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Ebook Copy Cover" } } });
});

const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("updateEbookCopyCoverData", () => {
  it("sets a cover on an ebook copy that has none yet", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Ebook Copy Cover Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-ebook-cover-1" } },
      },
      include: { ebookCopies: true },
    });
    const copy = book.ebookCopies[0];

    const result = await updateEbookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.ebookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
    savedPaths.push(updated.coverImagePath as string);
  });

  it("replaces an existing cover and deletes the old file", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    const book = await prisma.book.create({
      data: {
        title: "Test Ebook Copy Cover Replace Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-ebook-cover-2", coverImagePath: oldPath } },
      },
      include: { ebookCopies: true },
    });
    const copy = book.ebookCopies[0];

    const result = await updateEbookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.ebookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).not.toBe(oldPath);
    savedPaths.push(updated.coverImagePath as string);
    await expect(readFile(path.join(uploadsDir, oldPath))).rejects.toThrow();
  });

  it("returns an error and leaves the copy unchanged for an invalid cover", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Ebook Copy Cover Invalid Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-ebook-cover-3" } },
      },
      include: { ebookCopies: true },
    });
    const copy = book.ebookCopies[0];

    const result = await updateEbookCopyCoverData(copy.id, {
      selectedCoverDataUrl: "not-a-data-url",
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ error: "Invalid cover image" });
    const unchanged = await prisma.ebookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(unchanged.coverImagePath).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ebookCopies.test.ts`
Expected: FAIL — `Cannot find module '@/lib/ebookCopies'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/ebookCopies.ts
import { prisma } from "@/lib/prisma";
import { resolveCoverUpdate, type CoverSelectionInput } from "@/lib/copyCovers";

export async function updateEbookCopyCoverData(
  copyId: string,
  input: CoverSelectionInput,
): Promise<{ ok: true } | { error: string }> {
  const existing = await prisma.ebookCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { coverImagePath: true },
  });

  const result = await resolveCoverUpdate(input, existing.coverImagePath);
  if ("error" in result) {
    return result;
  }

  await prisma.ebookCopy.update({
    where: { id: copyId },
    data: { coverImagePath: result.coverImagePath },
  });

  return { ok: true };
}
```

```typescript
// src/lib/actions/ebookCopies.ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateEbookCopyCoverData } from "@/lib/ebookCopies";
import type { CopyFormState } from "@/lib/copies";

export async function updateEbookCopyCover(
  copyId: string,
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await updateEbookCopyCoverData(copyId, {
    selectedCoverDataUrl: formData.get("selectedCoverDataUrl")?.toString() ?? "",
    selectedCoverSource: formData.get("selectedCoverSource")?.toString(),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/ebookCopies.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/ebookCopies.ts src/lib/ebookCopies.test.ts src/lib/actions/ebookCopies.ts`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/lib/ebookCopies.ts src/lib/ebookCopies.test.ts src/lib/actions/ebookCopies.ts
git commit -m "feat: add cover update support for EbookCopy"
```

---

### Task 3: Audiobook copy cover update (lib + action)

**Files:**
- Create: `src/lib/audiobookCopies.ts`
- Test: `src/lib/audiobookCopies.test.ts`
- Create: `src/lib/actions/audiobookCopies.ts`

Exact mirror of Task 2 for `AudiobookCopy`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/audiobookCopies.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { updateAudiobookCopyCoverData } from "@/lib/audiobookCopies";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const savedPaths: string[] = [];

afterEach(async () => {
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Audiobook Copy Cover" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Audiobook Copy Cover" } } });
});

const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("updateAudiobookCopyCoverData", () => {
  it("sets a cover on an audiobook copy that has none yet", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Audiobook Copy Cover Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-audiobook-cover-1" } },
      },
      include: { audiobookCopies: true },
    });
    const copy = book.audiobookCopies[0];

    const result = await updateAudiobookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.audiobookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
    savedPaths.push(updated.coverImagePath as string);
  });

  it("replaces an existing cover and deletes the old file", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    const book = await prisma.book.create({
      data: {
        title: "Test Audiobook Copy Cover Replace Book",
        hasAudiobook: true,
        audiobookCopies: {
          create: { absItemId: "test-audiobook-cover-2", coverImagePath: oldPath },
        },
      },
      include: { audiobookCopies: true },
    });
    const copy = book.audiobookCopies[0];

    const result = await updateAudiobookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.audiobookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).not.toBe(oldPath);
    savedPaths.push(updated.coverImagePath as string);
    await expect(readFile(path.join(uploadsDir, oldPath))).rejects.toThrow();
  });

  it("returns an error and leaves the copy unchanged for an invalid cover", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Audiobook Copy Cover Invalid Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-audiobook-cover-3" } },
      },
      include: { audiobookCopies: true },
    });
    const copy = book.audiobookCopies[0];

    const result = await updateAudiobookCopyCoverData(copy.id, {
      selectedCoverDataUrl: "not-a-data-url",
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ error: "Invalid cover image" });
    const unchanged = await prisma.audiobookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(unchanged.coverImagePath).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/audiobookCopies.test.ts`
Expected: FAIL — `Cannot find module '@/lib/audiobookCopies'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/audiobookCopies.ts
import { prisma } from "@/lib/prisma";
import { resolveCoverUpdate, type CoverSelectionInput } from "@/lib/copyCovers";

export async function updateAudiobookCopyCoverData(
  copyId: string,
  input: CoverSelectionInput,
): Promise<{ ok: true } | { error: string }> {
  const existing = await prisma.audiobookCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { coverImagePath: true },
  });

  const result = await resolveCoverUpdate(input, existing.coverImagePath);
  if ("error" in result) {
    return result;
  }

  await prisma.audiobookCopy.update({
    where: { id: copyId },
    data: { coverImagePath: result.coverImagePath },
  });

  return { ok: true };
}
```

```typescript
// src/lib/actions/audiobookCopies.ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateAudiobookCopyCoverData } from "@/lib/audiobookCopies";
import type { CopyFormState } from "@/lib/copies";

export async function updateAudiobookCopyCover(
  copyId: string,
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await updateAudiobookCopyCoverData(copyId, {
    selectedCoverDataUrl: formData.get("selectedCoverDataUrl")?.toString() ?? "",
    selectedCoverSource: formData.get("selectedCoverSource")?.toString(),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/audiobookCopies.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/audiobookCopies.ts src/lib/audiobookCopies.test.ts src/lib/actions/audiobookCopies.ts`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/lib/audiobookCopies.ts src/lib/audiobookCopies.test.ts src/lib/actions/audiobookCopies.ts
git commit -m "feat: add cover update support for AudiobookCopy"
```

---

### Task 4: Extend physical copy update with cover support

**Files:**
- Modify: `src/lib/copies.ts`
- Modify: `src/lib/copies.test.ts`
- Modify: `src/lib/actions/copies.ts`

- [ ] **Step 1: Write the failing tests**

Add these two new test cases inside the existing `describe("updateCopyData", ...)` block in `src/lib/copies.test.ts` (the file already has `createTestBook()`, `createdBookIds` cleanup, and imports — add alongside the existing tests, don't remove anything):

```typescript
  it("sets a cover on a copy that has none yet", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });
    const ONE_PX_PNG_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const result = await updateCopyData(existingCopy.id, {
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.physicalCopy.findUniqueOrThrow({ where: { id: existingCopy.id } });
    expect(updated.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
    await deleteCoverImage(updated.coverImagePath as string);
  });

  it("leaves an existing cover untouched when no new cover is selected", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await updateCopyData(existingCopy.id, {
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      selectedCoverDataUrl: "",
      selectedCoverSource: undefined,
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.physicalCopy.findUniqueOrThrow({ where: { id: existingCopy.id } });
    expect(updated.coverImagePath).toBeNull();
    expect(updated.format).toBe("PAPERBACK");
  });
```

Add the corresponding import at the top of the file (alongside the existing imports):

```typescript
import { deleteCoverImage } from "@/lib/coverStorage";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/copies.test.ts`
Expected: FAIL — `updateCopyData` doesn't accept `selectedCoverDataUrl`/`selectedCoverSource` yet (TypeScript error) and the cover isn't actually saved.

- [ ] **Step 3: Update the implementation**

In `src/lib/copies.ts`, add the import and extend `CopyFieldsInput` and `updateCopyData`:

```typescript
import { prisma } from "@/lib/prisma";
import { parseCopyFields } from "@/lib/books";
import { resolveCoverUpdate, type CoverSelectionInput } from "@/lib/copyCovers";

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
    select: { bookId: true },
  });

  await prisma.physicalCopy.delete({ where: { id: copyId } });

  const remaining = await prisma.physicalCopy.count({ where: { bookId: copy.bookId } });

  if (remaining === 0) {
    const book = await prisma.book.findUniqueOrThrow({
      where: { id: copy.bookId },
      select: { hasEbook: true, hasAudiobook: true },
    });
    if (!book.hasEbook && !book.hasAudiobook) {
      await prisma.book.delete({ where: { id: copy.bookId } });
      return { bookId: copy.bookId, bookDeleted: true };
    }
  }

  return { bookId: copy.bookId, bookDeleted: false };
}
```

(`addCopyData` is unchanged — the "add a new copy" flow is explicitly out of scope per the design spec, only editing an existing copy gains cover support.)

In `src/lib/actions/copies.ts`, extend `updateCopy` to pass through the new fields:

```typescript
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { addCopyData, updateCopyData, deleteCopyData, type CopyFormState } from "@/lib/copies";

export async function addCopy(
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await addCopyData(bookId, {
    format: (formData.get("format") as string) ?? "",
    publisher: (formData.get("publisher") as string) ?? "",
    publishYear: (formData.get("publishYear") as string) ?? "",
    specialNotes: (formData.get("specialNotes") as string) ?? "",
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
}

export async function updateCopy(
  copyId: string,
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await updateCopyData(copyId, {
    format: (formData.get("format") as string) ?? "",
    publisher: (formData.get("publisher") as string) ?? "",
    publishYear: (formData.get("publishYear") as string) ?? "",
    specialNotes: (formData.get("specialNotes") as string) ?? "",
    selectedCoverDataUrl: formData.get("selectedCoverDataUrl")?.toString() ?? "",
    selectedCoverSource: formData.get("selectedCoverSource")?.toString(),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
}

export async function deleteCopy(copyId: string, _formData: FormData): Promise<void> {
  let bookId: string;
  let bookDeleted: boolean;

  try {
    const result = await deleteCopyData(copyId);
    bookId = result.bookId;
    bookDeleted = result.bookDeleted;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      revalidatePath("/books");
      redirect("/books");
    }
    throw error;
  }

  if (bookDeleted) {
    revalidatePath("/books");
    redirect("/books");
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/copies.test.ts`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/copies.ts src/lib/copies.test.ts src/lib/actions/copies.ts`
Expected: clean

- [ ] **Step 6: Commit**

```bash
git add src/lib/copies.ts src/lib/copies.test.ts src/lib/actions/copies.ts
git commit -m "feat: support editing a physical copy's cover"
```

---

### Task 5: `CoverEditor` shared component

**Files:**
- Create: `src/components/CoverEditor.tsx`

No automated test — this project has no component-testing framework, and neither `CoverPicker.tsx` nor `CoverCamera.tsx` (the closest existing precedents) have one either. Verified manually in Task 9.

- [ ] **Step 1: Write the component**

```tsx
// src/components/CoverEditor.tsx
"use client";

import { useState, type ChangeEvent } from "react";
import { CoverCamera } from "@/components/CoverCamera";

interface CoverEditorProps {
  currentCoverPath: string | null;
  bookIsbn: string | null;
  allowCamera?: boolean;
}

// Shared cover-picking UI reused across the physical/ebook/audiobook copy
// edit pages. Outputs the same two hidden fields CoverPicker already
// established (selectedCoverDataUrl / selectedCoverSource) so the
// surrounding <form>'s submit handling and resolveCoverUpdate (src/lib/copyCovers.ts)
// don't need to know which UI produced them.
export function CoverEditor({
  currentCoverPath,
  bookIsbn,
  allowCamera = false,
}: CoverEditorProps) {
  const [selectedDataUrl, setSelectedDataUrl] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<"dataUrl" | "url" | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);

  async function handleLookup() {
    if (!bookIsbn) return;
    setIsLookingUp(true);
    setLookupError(null);
    try {
      const response = await fetch(`/api/isbn-lookup?isbn=${encodeURIComponent(bookIsbn)}`);
      const data = await response.json();
      if (!response.ok || !data.coverUrl) {
        setLookupError("No Open Library cover found for this ISBN.");
        return;
      }
      setSelectedDataUrl(data.coverUrl);
      setSelectedSource("url");
    } catch {
      setLookupError("Couldn't reach the lookup service.");
    } finally {
      setIsLookingUp(false);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setSelectedDataUrl(reader.result);
        setSelectedSource("dataUrl");
      }
    };
    reader.readAsDataURL(file);
  }

  const previewSrc =
    selectedDataUrl ??
    (currentCoverPath ? `/api/covers/${encodeURIComponent(currentCoverPath)}` : null);

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Cover Image</p>
      {previewSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewSrc} alt="Cover" className="mb-2 h-32 w-24 rounded object-cover" />
      ) : (
        <p className="mb-2 text-sm text-gray-600">No cover set.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer text-sm underline">
          Upload a file
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
        {bookIsbn && (
          <button
            type="button"
            onClick={handleLookup}
            disabled={isLookingUp}
            className="text-sm underline disabled:opacity-50"
          >
            {isLookingUp ? "Looking up..." : "Use Open Library cover"}
          </button>
        )}
        {allowCamera && (
          <button
            type="button"
            onClick={() => setShowCamera(true)}
            className="text-sm underline"
          >
            Take a photo
          </button>
        )}
      </div>
      {lookupError && <p className="mt-1 text-sm text-red-600">{lookupError}</p>}
      {allowCamera && showCamera && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Take a cover photo"
          className="fixed inset-0 z-10 overflow-y-auto bg-white p-4"
        >
          <CoverCamera
            onCapture={(dataUrl) => {
              setSelectedDataUrl(dataUrl);
              setSelectedSource("dataUrl");
              setShowCamera(false);
            }}
            onSkip={() => setShowCamera(false)}
          />
        </div>
      )}
      <input type="hidden" name="selectedCoverDataUrl" value={selectedDataUrl ?? ""} />
      <input type="hidden" name="selectedCoverSource" value={selectedSource ?? ""} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/components/CoverEditor.tsx`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/components/CoverEditor.tsx
git commit -m "feat: add shared CoverEditor component"
```

---

### Task 6: Ebook copy edit page

**Files:**
- Create: `src/app/books/[id]/ebook-copies/[copyId]/edit/page.tsx`
- Create: `src/app/books/[id]/ebook-copies/[copyId]/edit/EditEbookCopyCoverForm.tsx`

- [ ] **Step 1: Write the page**

```tsx
// src/app/books/[id]/ebook-copies/[copyId]/edit/page.tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditEbookCopyCoverForm } from "./EditEbookCopyCoverForm";

export default async function EditEbookCopyPage({
  params,
}: {
  params: Promise<{ id: string; copyId: string }>;
}) {
  const { id, copyId } = await params;
  const copy = await prisma.ebookCopy.findUnique({
    where: { id: copyId },
    include: { book: true },
  });

  if (!copy || copy.bookId !== id) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-2xl font-semibold">Edit Ebook Cover</h1>
      <p className="mb-4 text-gray-600">{copy.book.title}</p>
      <EditEbookCopyCoverForm
        copyId={copy.id}
        bookId={id}
        currentCoverPath={copy.coverImagePath}
        bookIsbn={copy.book.isbn}
      />
    </main>
  );
}
```

```tsx
// src/app/books/[id]/ebook-copies/[copyId]/edit/EditEbookCopyCoverForm.tsx
"use client";

import { useActionState } from "react";
import { updateEbookCopyCover } from "@/lib/actions/ebookCopies";
import type { CopyFormState } from "@/lib/copies";
import { CoverEditor } from "@/components/CoverEditor";

const initialState: CopyFormState = {};

interface EditEbookCopyCoverFormProps {
  copyId: string;
  bookId: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditEbookCopyCoverForm({
  copyId,
  bookId,
  currentCoverPath,
  bookIsbn,
}: EditEbookCopyCoverFormProps) {
  const updateThisCopy = updateEbookCopyCover.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <CoverEditor currentCoverPath={currentCoverPath} bookIsbn={bookIsbn} />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Save"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/books/\[id\]/ebook-copies/\[copyId\]/edit/page.tsx src/app/books/\[id\]/ebook-copies/\[copyId\]/edit/EditEbookCopyCoverForm.tsx`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add "src/app/books/[id]/ebook-copies"
git commit -m "feat: add ebook copy cover edit page"
```

---

### Task 7: Audiobook copy edit page

**Files:**
- Create: `src/app/books/[id]/audiobook-copies/[copyId]/edit/page.tsx`
- Create: `src/app/books/[id]/audiobook-copies/[copyId]/edit/EditAudiobookCopyCoverForm.tsx`

Exact mirror of Task 6 for `AudiobookCopy`.

- [ ] **Step 1: Write the page**

```tsx
// src/app/books/[id]/audiobook-copies/[copyId]/edit/page.tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditAudiobookCopyCoverForm } from "./EditAudiobookCopyCoverForm";

export default async function EditAudiobookCopyPage({
  params,
}: {
  params: Promise<{ id: string; copyId: string }>;
}) {
  const { id, copyId } = await params;
  const copy = await prisma.audiobookCopy.findUnique({
    where: { id: copyId },
    include: { book: true },
  });

  if (!copy || copy.bookId !== id) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-2xl font-semibold">Edit Audiobook Cover</h1>
      <p className="mb-4 text-gray-600">{copy.book.title}</p>
      <EditAudiobookCopyCoverForm
        copyId={copy.id}
        bookId={id}
        currentCoverPath={copy.coverImagePath}
        bookIsbn={copy.book.isbn}
      />
    </main>
  );
}
```

```tsx
// src/app/books/[id]/audiobook-copies/[copyId]/edit/EditAudiobookCopyCoverForm.tsx
"use client";

import { useActionState } from "react";
import { updateAudiobookCopyCover } from "@/lib/actions/audiobookCopies";
import type { CopyFormState } from "@/lib/copies";
import { CoverEditor } from "@/components/CoverEditor";

const initialState: CopyFormState = {};

interface EditAudiobookCopyCoverFormProps {
  copyId: string;
  bookId: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditAudiobookCopyCoverForm({
  copyId,
  bookId,
  currentCoverPath,
  bookIsbn,
}: EditAudiobookCopyCoverFormProps) {
  const updateThisCopy = updateAudiobookCopyCover.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <CoverEditor currentCoverPath={currentCoverPath} bookIsbn={bookIsbn} />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Save"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/books/\[id\]/audiobook-copies/\[copyId\]/edit/page.tsx src/app/books/\[id\]/audiobook-copies/\[copyId\]/edit/EditAudiobookCopyCoverForm.tsx`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add "src/app/books/[id]/audiobook-copies"
git commit -m "feat: add audiobook copy cover edit page"
```

---

### Task 8: Extend physical copy edit page with CoverEditor

**Files:**
- Modify: `src/app/books/[id]/copies/[copyId]/edit/page.tsx`
- Modify: `src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx`

- [ ] **Step 1: Update the page to pass the new props**

```tsx
// src/app/books/[id]/copies/[copyId]/edit/page.tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditCopyForm } from "./EditCopyForm";

export default async function EditCopyPage({
  params,
}: {
  params: Promise<{ id: string; copyId: string }>;
}) {
  const { id, copyId } = await params;
  const copy = await prisma.physicalCopy.findUnique({
    where: { id: copyId },
    include: { book: true },
  });

  if (!copy || copy.bookId !== id) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-2xl font-semibold">Edit Copy</h1>
      <p className="mb-4 text-gray-600">{copy.book.title}</p>
      <EditCopyForm
        copyId={copy.id}
        bookId={id}
        defaultFormat={copy.format}
        defaultPublisher={copy.publisher ?? ""}
        defaultPublishYear={copy.publishYear?.toString() ?? ""}
        defaultSpecialNotes={copy.specialNotes ?? ""}
        currentCoverPath={copy.coverImagePath}
        bookIsbn={copy.book.isbn}
      />
    </main>
  );
}
```

- [ ] **Step 2: Update the form component**

```tsx
// src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx
"use client";

import { useActionState } from "react";
import { updateCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";
import { CoverEditor } from "@/components/CoverEditor";

const initialState: CopyFormState = {};

interface EditCopyFormProps {
  copyId: string;
  bookId: string;
  defaultFormat: string;
  defaultPublisher: string;
  defaultPublishYear: string;
  defaultSpecialNotes: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditCopyForm({
  copyId,
  bookId,
  defaultFormat,
  defaultPublisher,
  defaultPublishYear,
  defaultSpecialNotes,
  currentCoverPath,
  bookIsbn,
}: EditCopyFormProps) {
  const updateThisCopy = updateCopy.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields
        defaultFormat={defaultFormat}
        defaultPublisher={defaultPublisher}
        defaultPublishYear={defaultPublishYear}
        defaultSpecialNotes={defaultSpecialNotes}
      />
      <CoverEditor currentCoverPath={currentCoverPath} bookIsbn={bookIsbn} allowCamera />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : "Save"}
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/app/books/\[id\]/copies/\[copyId\]/edit/page.tsx src/app/books/\[id\]/copies/\[copyId\]/edit/EditCopyForm.tsx`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add "src/app/books/[id]/copies/[copyId]/edit/page.tsx" "src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx"
git commit -m "feat: add cover editing to the physical copy edit page"
```

---

### Task 9: List ebook/audiobook copies on the book detail page

**Files:**
- Modify: `src/app/books/[id]/page.tsx`

- [ ] **Step 1: Update the query and render the new sections**

```tsx
// src/app/books/[id]/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deleteCopy } from "@/lib/actions/copies";
import {
  updateReadStatus,
  updateRating,
  clearReadStatusManual,
  clearRatingManual,
} from "@/lib/actions/readingProgress";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_OPTIONS, RATING_OPTIONS } from "@/components/ReadingProgressFields";

export default async function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({
    where: { id },
    include: {
      copies: { orderBy: { createdAt: "asc" } },
      ebookCopies: { orderBy: { createdAt: "asc" } },
      audiobookCopies: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{book.title}</h1>
          {book.author && <p className="text-gray-600">{book.author}</p>}
          {book.isbn && <p className="text-sm text-gray-500">ISBN: {book.isbn}</p>}
        </div>
        <Link href={`/books/${book.id}/edit`} className="rounded border px-3 py-2 text-sm">
          Edit
        </Link>
      </div>

      <div className="mb-4 space-y-2 rounded border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <form action={updateReadStatus.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="readStatus" className="text-sm font-medium">
              Status
            </label>
            <select
              id="readStatus"
              name="readStatus"
              defaultValue={book.readStatus ?? ""}
              className="rounded border p-1 text-sm"
            >
              <option value="">Not set</option>
              {READ_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded border px-2 py-1 text-sm">
              Save
            </button>
          </form>
          <span className="text-xs text-gray-500">
            {book.readStatusManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.readStatusManual && (
            <form action={clearReadStatusManual.bind(null, book.id)}>
              <button type="submit" className="text-xs underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={updateRating.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="rating" className="text-sm font-medium">
              Rating
            </label>
            <select
              id="rating"
              name="rating"
              defaultValue={book.rating?.toString() ?? ""}
              className="rounded border p-1 text-sm"
            >
              <option value="">Unrated</option>
              {RATING_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "star" : "stars"}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded border px-2 py-1 text-sm">
              Save
            </button>
          </form>
          <span className="text-xs text-gray-500">
            {book.ratingManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.ratingManual && (
            <form action={clearRatingManual.bind(null, book.id)}>
              <button type="submit" className="text-xs underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Copies ({book.copies.length})</h2>
        <Link
          href={`/books/${book.id}/copies/new`}
          className="rounded bg-black px-3 py-2 text-sm text-white"
        >
          + Add a copy
        </Link>
      </div>

      <ul className="space-y-3">
        {book.copies.map((copy) => (
          <li key={copy.id} className="rounded border p-3">
            <p className="font-medium">{FORMAT_LABELS[copy.format]}</p>
            {copy.publisher && <p className="text-sm text-gray-600">{copy.publisher}</p>}
            {copy.publishYear && <p className="text-sm text-gray-600">{copy.publishYear}</p>}
            {copy.specialNotes && <p className="text-sm text-gray-600">{copy.specialNotes}</p>}
            {copy.coverImagePath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                alt="Cover"
                className="mt-2 h-32 w-24 rounded object-cover"
              />
            )}
            <div className="mt-2 flex gap-2">
              <Link
                href={`/books/${book.id}/copies/${copy.id}/edit`}
                className="text-sm underline"
              >
                Edit
              </Link>
              <form action={deleteCopy.bind(null, copy.id)}>
                <button type="submit" className="text-sm text-red-600 underline">
                  Delete
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>

      {book.ebookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-medium">Ebooks ({book.ebookCopies.length})</h2>
          <ul className="space-y-3">
            {book.ebookCopies.map((copy) => (
              <li key={copy.id} className="rounded border p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-gray-600">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/ebook-copies/${copy.id}/edit`}
                  className="mt-2 inline-block text-sm underline"
                >
                  Edit cover
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {book.audiobookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-lg font-medium">
            Audiobooks ({book.audiobookCopies.length})
          </h2>
          <ul className="space-y-3">
            {book.audiobookCopies.map((copy) => (
              <li key={copy.id} className="rounded border p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-gray-600">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/audiobook-copies/${copy.id}/edit`}
                  className="mt-2 inline-block text-sm underline"
                >
                  Edit cover
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint "src/app/books/[id]/page.tsx"`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add "src/app/books/[id]/page.tsx"
git commit -m "feat: list ebook/audiobook copies on the book detail page"
```

---

### Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new ones from Tasks 1–4.

- [ ] **Step 2: Full typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean (aside from the two pre-existing, unrelated issues noted in every prior phase this session: a `set-state-in-effect` warning in `CoverPicker.tsx` and an unused-var warning in `src/lib/actions/copies.ts`).

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual browser verification**

Since `CoverEditor` and the new/updated pages have no automated tests, start the dev server and verify in a real browser (mint a session cookie via `iron-session`'s `sealData` using `SESSION_SECRET`, as done for the `RefreshSyncButton` fix — see `[[repo-github-setup]]` memory for the exact technique):

- Open a book with at least one ebook and one audiobook copy (sync one via `syncAbsCache` against a real or test ABS instance, or create rows directly in the dev DB for verification purposes).
- Confirm the "Ebooks"/"Audiobooks" sections render, each copy shows "No cover set." initially.
- Click "Edit cover" on an ebook copy, upload a local image file, save, confirm redirect back to the book page and the new cover thumbnail renders.
- Repeat for an audiobook copy.
- Edit an existing physical copy, use the "Use Open Library cover" button (requires the book to have a real ISBN with Open Library coverage), confirm the preview updates and saving persists it.
- Edit a physical copy's cover via file upload when it already has a cover; confirm the old cover file no longer resolves (spot-check via the covers API route) after saving the new one.

## Self-Review

**Spec coverage:** Every section of `docs/superpowers/specs/2026-07-17-copy-covers-design.md` maps to a task — Architecture/Data Flow → Tasks 1–5, Routes & Pages → Tasks 6–8, Book Detail Page Changes → Task 9, Testing → woven into Tasks 1–4 and Task 10. Non-goals (cover thumbnails in listings, `/books`/`/tbr` filters, capture-tool improvements, ebook/audiobook copy deletion) are untouched by every task above.

**Placeholder scan:** No TBD/TODO markers; every step has complete, concrete code.

**Type consistency:** `CoverSelectionInput` (defined in Task 1) is the single shared shape threaded through Tasks 2–4's function signatures without renaming. The new ebook/audiobook cover actions and form components reuse the existing `CopyFormState` (`@/lib/copies`, unchanged, already `{error?: string}`) rather than defining a redundant identical type — avoids an awkward cross-dependency between the ebook and audiobook action files that an earlier draft of this plan had.
