# Phase 3: Barcode Scan + Cover Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user add a book by scanning its barcode with a phone camera — auto-filling title/author/publisher/year from Open Library, capturing a cover photo of their actual copy (with an Open Library cover image as a fallback choice), and saving both the metadata and the chosen cover image alongside the existing manual add-book flow from Phase 2.

**Architecture:** A new `/books/scan` page hosts a `BarcodeScanner` client component (`@zxing/library` + `getUserMedia`) that continuously decodes EAN-13 barcodes from the camera feed. On a decode, it captures a video frame as a cover-photo candidate and calls a server-side ISBN lookup API route (a proxy to Open Library, avoiding browser CORS issues). The user is shown a pre-filled form with both candidate cover images to choose from, then saves via an extended version of the Phase 2 `createBookWithCopy` data layer that also accepts a `coverImagePath` and de-duplicates by exact ISBN match against existing `Book` rows. Cover images (both the captured photo and any chosen Open Library image) are persisted to a local uploads directory via a small file-storage API route and served back through a dynamic Next.js route handler. The existing Phase 2 manual-entry flow (`/books/new`) is kept as-is and reachable via a "manual entry" link, per the design spec's explicit fallback requirement.

**Tech Stack:** Next.js 16 App Router route handlers, `@zxing/library` for barcode decoding, browser `getUserMedia`/`<canvas>` for camera access and frame capture, Node `fs/promises` for local disk storage of cover images, Open Library Books API (`https://openlibrary.org/api/books`) and Covers API (`https://covers.openlibrary.org`) for metadata/cover lookup, Vitest for the parts that don't require real camera hardware.

---

## Important scoping note (read before starting)

The design spec's Add-Book Flow step 5 says a new copy should attach to an existing `Book` "if an existing Book matches by ISBN, **or by fuzzy title/author match** if ISBN is missing/absent." The fuzzy-title-matching module (ported from `audiobook-compare/compare_audiobooks.py`) is **not built yet** — it's explicitly scoped to Phase 4 ("ABS Sync + Unified Search") in the phase roadmap. Building it early here would duplicate work and risk diverging from Phase 4's ported implementation.

**Phase 3 scope for de-duplication is therefore ISBN-exact-match only**: if the scanned/entered ISBN exactly matches an existing `Book.isbn`, the new copy attaches to that book. If the ISBN is missing or doesn't match anything, a new `Book` is created (same as the existing Phase 2 manual flow). The fuzzy-match fallback is deferred to Phase 4, where the ported matching module will exist to power it correctly across `Book`, `AbsCacheItem`, and `GoodreadsTbrItem` in one consistent place. This is a deliberate, scoped decision — do not attempt to build fuzzy matching in this phase.

**Hardware verification note:** Per the design spec's own Testing section, "Barcode scanning / camera: not practical to unit test (hardware- and browser-dependent) — verified manually on both an iOS and an Android device during implementation." **Subagents implementing this plan do not have access to a real phone camera.** Every task below is structured so its automated/live-verification steps use things a subagent *can* actually check (unit tests with mocked fetch, a static test image file fed through a file input instead of a live camera where the flow allows it, API routes tested directly via curl, component code review for correctness). Task 8 explicitly calls out the real-device QA as a manual checklist for the user to run themselves — no subagent should ever claim to have verified live camera/barcode behavior on real hardware, since that claim cannot be true.

---

### Task 1: Add barcode-scanning dependency and uploads directory scaffolding

**Files:**
- Modify: `package.json` (add `@zxing/library` dependency)
- Create: `.env.example` (add `UPLOADS_DIR` line)
- Create: `uploads/.gitkeep`
- Modify: `.gitignore` (ignore uploads contents but keep the directory tracked)

- [ ] **Step 1: Install the barcode-scanning library**

```bash
npm install @zxing/library
```

Expected: `package.json` and `package-lock.json` updated, `node_modules/@zxing` present.

- [ ] **Step 2: Add the uploads directory env var**

Add this line to `.env.example` (after `APP_PASSWORD_HASH`):

```
UPLOADS_DIR="./uploads"
```

Add the same line to your local `.env` (do not commit `.env`, it's already gitignored).

- [ ] **Step 3: Create the uploads directory, keep it tracked but ignore its contents**

```bash
mkdir -p uploads
```

Create `uploads/.gitkeep` (empty file).

Add these two lines to `.gitignore`, right after the existing `# env files` block:

```
# uploaded cover images
/uploads/*
!/uploads/.gitkeep
```

- [ ] **Step 4: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors (this task adds no TypeScript yet, this just confirms nothing broke).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example .gitignore uploads/.gitkeep
git commit -m "chore: add barcode-scanning dependency and uploads directory"
```

---

### Task 2: Cover image storage — save and serve

**Files:**
- Create: `src/lib/coverStorage.ts`
- Create: `src/lib/coverStorage.test.ts`
- Create: `src/app/api/covers/[filename]/route.ts`

- [ ] **Step 1: Write the failing test for saving a cover image**

```typescript
// src/lib/coverStorage.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const savedPaths: string[] = [];

afterEach(async () => {
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
});

describe("saveCoverImage", () => {
  it("saves a base64 PNG data URL to disk and returns its relative path", async () => {
    // 1x1 transparent PNG
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const relPath = await saveCoverImage(dataUrl);
    savedPaths.push(relPath);

    expect(relPath).toMatch(/^[a-f0-9-]+\.png$/);
    const written = await readFile(path.join(uploadsDir, relPath));
    expect(written.length).toBeGreaterThan(0);
  });

  it("rejects a data URL with an unsupported mime type", async () => {
    const dataUrl = "data:text/plain;base64,aGVsbG8=";
    await expect(saveCoverImage(dataUrl)).rejects.toThrow(/unsupported image type/i);
  });

  it("rejects a malformed data URL", async () => {
    await expect(saveCoverImage("not-a-data-url")).rejects.toThrow(/invalid data url/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run coverStorage`
Expected: FAIL with "Cannot find module '@/lib/coverStorage'" (or similar — the module doesn't exist yet).

- [ ] **Step 3: Implement cover storage**

```typescript
// src/lib/coverStorage.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/;

export async function saveCoverImage(dataUrl: string): Promise<string> {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid data URL");
  }

  const [, mimeType, base64Data] = match;
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }

  await mkdir(UPLOADS_DIR, { recursive: true });

  const filename = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64Data, "base64");
  await writeFile(path.join(UPLOADS_DIR, filename), buffer);

  return filename;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run coverStorage`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the route handler that serves a saved cover image**

```typescript
// src/app/api/covers/[filename]/route.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  // Reject any path-traversal attempt or unexpected characters up front —
  // valid filenames are always a UUID plus a known extension (see saveCoverImage).
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(filename)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = filename.split(".").pop()!;
  const mimeType = EXT_TO_MIME[ext];

  try {
    const data = await readFile(path.join(UPLOADS_DIR, filename));
    return new NextResponse(data, {
      headers: { "Content-Type": mimeType, "Cache-Control": "private, max-age=31536000" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
```

- [ ] **Step 6: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Verify the route live**

```bash
npm run dev
```

In another terminal, save a test image directly using the same helper, then fetch it:

```bash
node -e "
const { saveCoverImage } = require('./src/lib/coverStorage.ts');
" 2>/dev/null || true
```

Since that file is TypeScript, instead verify via the app's own test suite (already covers `saveCoverImage`) plus a manual curl round-trip against a file you drop into `uploads/` yourself:

```bash
cp uploads/.gitkeep /tmp/test.png 2>/dev/null || true
# Use any small real PNG on disk instead if available, e.g.:
# cp path/to/any-icon.png uploads/11111111-1111-1111-1111-111111111111.png
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/covers/11111111-1111-1111-1111-111111111111.png
```

Expected: `200` if the file exists in `uploads/`, `404` if not — and confirm a request for a path-traversal-style filename like `../../.env` returns `404` (not the actual `.env` contents):

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/covers/..%2F..%2F.env"
```

Expected: `404`.

Clean up any test file you created in `uploads/`, then stop the dev server via targeted PID kill (`netstat -ano | grep LISTENING` on port 3000, `taskkill //PID <pid> //F`).

- [ ] **Step 8: Commit**

```bash
git add src/lib/coverStorage.ts src/lib/coverStorage.test.ts "src/app/api/covers/[filename]/route.ts"
git commit -m "feat: add cover image storage and serving"
```

---

### Task 3: ISBN lookup API route (Open Library proxy)

**Files:**
- Create: `src/lib/isbnLookup.ts`
- Create: `src/lib/isbnLookup.test.ts`
- Create: `src/app/api/isbn-lookup/route.ts`

- [ ] **Step 1: Write the failing test for the lookup function**

```typescript
// src/lib/isbnLookup.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupIsbn } from "@/lib/isbnLookup";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("lookupIsbn", () => {
  it("returns title/author/publisher/publishYear/coverUrl on a successful Open Library response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        "ISBN:9780765326355": {
          title: "The Way of Kings",
          authors: [{ name: "Brandon Sanderson" }],
          publishers: [{ name: "Tor Fantasy" }],
          publish_date: "2011",
          cover: { medium: "https://covers.openlibrary.org/b/id/12345-M.jpg" },
        },
      }),
    } as Response);

    const result = await lookupIsbn("9780765326355");

    expect(result).toEqual({
      title: "The Way of Kings",
      author: "Brandon Sanderson",
      publisher: "Tor Fantasy",
      publishYear: 2011,
      coverUrl: "https://covers.openlibrary.org/b/id/12345-M.jpg",
    });
  });

  it("returns all-null fields when Open Library has no data for the ISBN", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await lookupIsbn("0000000000000");

    expect(result).toEqual({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
  });

  it("returns all-null fields when the Open Library request itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await lookupIsbn("9780765326355");

    expect(result).toEqual({
      title: null,
      author: null,
      publisher: null,
      publishYear: null,
      coverUrl: null,
    });
  });

  it("extracts a 4-digit year from a messy publish_date string", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        "ISBN:1234567890123": {
          title: "Some Book",
          publish_date: "March 15, 1999",
        },
      }),
    } as Response);

    const result = await lookupIsbn("1234567890123");
    expect(result.publishYear).toBe(1999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run isbnLookup`
Expected: FAIL with "Cannot find module '@/lib/isbnLookup'".

- [ ] **Step 3: Implement the lookup function**

```typescript
// src/lib/isbnLookup.ts
export interface IsbnLookupResult {
  title: string | null;
  author: string | null;
  publisher: string | null;
  publishYear: number | null;
  coverUrl: string | null;
}

const EMPTY_RESULT: IsbnLookupResult = {
  title: null,
  author: null,
  publisher: null,
  publishYear: null,
  coverUrl: null,
};

export async function lookupIsbn(isbn: string): Promise<IsbnLookupResult> {
  try {
    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(
      isbn,
    )}&format=json&jscmd=data`;
    const response = await fetch(url);
    if (!response.ok) {
      return EMPTY_RESULT;
    }

    const data = await response.json();
    const entry = data[`ISBN:${isbn}`];
    if (!entry) {
      return EMPTY_RESULT;
    }

    const yearMatch = /\d{4}/.exec(entry.publish_date ?? "");

    return {
      title: entry.title ?? null,
      author: entry.authors?.[0]?.name ?? null,
      publisher: entry.publishers?.[0]?.name ?? null,
      publishYear: yearMatch ? parseInt(yearMatch[0], 10) : null,
      coverUrl: entry.cover?.medium ?? entry.cover?.large ?? entry.cover?.small ?? null,
    };
  } catch {
    return EMPTY_RESULT;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run isbnLookup`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the API route**

```typescript
// src/app/api/isbn-lookup/route.ts
import { NextResponse } from "next/server";
import { lookupIsbn } from "@/lib/isbnLookup";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const isbn = searchParams.get("isbn");

  if (!isbn || !/^\d{10,13}$/.test(isbn)) {
    return NextResponse.json({ error: "A valid ISBN is required" }, { status: 400 });
  }

  const result = await lookupIsbn(isbn);
  return NextResponse.json(result);
}
```

- [ ] **Step 6: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Verify the route live**

```bash
npm run dev
```

```bash
curl -s "http://localhost:3000/api/isbn-lookup?isbn=9780765326355" | head -c 400
```

Expected: JSON with real title/author data for "The Way of Kings" (a real, published ISBN), fetched live from Open Library.

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/isbn-lookup?isbn=not-a-number"
```

Expected: `400`.

Stop the dev server via targeted PID kill.

- [ ] **Step 8: Commit**

```bash
git add src/lib/isbnLookup.ts src/lib/isbnLookup.test.ts src/app/api/isbn-lookup/route.ts
git commit -m "feat: add ISBN lookup API route (Open Library proxy)"
```

---

### Task 4: Extend book creation to support cover image + ISBN dedup

**Files:**
- Modify: `src/lib/books.ts:47-70` (`createBookWithCopyData`)
- Modify: `src/lib/books.test.ts` (add new tests, keep all existing ones passing)
- Modify: `src/lib/actions/books.ts` (thin wrapper — accept the new field)

- [ ] **Step 1: Write the failing tests for the extended behavior**

Add these tests to the end of the existing `describe` block for `createBookWithCopyData` in `src/lib/books.test.ts` (read the existing file first to match its existing `afterEach` cleanup pattern — delete `physicalCopy` rows before `book` rows):

```typescript
  it("accepts an optional coverImagePath and stores it on the copy", async () => {
    const result = await createBookWithCopyData({
      title: "Cover Test Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      coverImagePath: "abc123.png",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: result.bookId },
      include: { copies: true },
    });
    expect(book.copies[0].coverImagePath).toBe("abc123.png");
  });

  it("attaches a new copy to an existing book with the same ISBN instead of creating a duplicate", async () => {
    const first = await createBookWithCopyData({
      title: "Dedup Test Book",
      author: "Original Author",
      isbn: "9999999999999",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in first).toBe(false);
    if ("error" in first) return;

    const second = await createBookWithCopyData({
      title: "Dedup Test Book (Reissue Title Ignored)",
      author: "",
      isbn: "9999999999999",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in second).toBe(false);
    if ("error" in second) return;

    expect(second.bookId).toBe(first.bookId);

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: first.bookId },
      include: { copies: true },
    });
    expect(book.copies).toHaveLength(2);
    expect(book.title).toBe("Dedup Test Book"); // original title preserved, not overwritten
  });

  it("creates a new book when the ISBN doesn't match any existing book", async () => {
    const first = await createBookWithCopyData({
      title: "No Match Book One",
      author: "",
      isbn: "1111111111111",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in first).toBe(false);
    if ("error" in first) return;

    const second = await createBookWithCopyData({
      title: "No Match Book Two",
      author: "",
      isbn: "2222222222222",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in second).toBe(false);
    if ("error" in second) return;

    expect(second.bookId).not.toBe(first.bookId);
  });
```

Make sure the file's imports still include `prisma` from `@/lib/prisma` (it already does, per the existing test file).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test -- --run books.test`
Expected: FAIL — `coverImagePath` isn't accepted by the current type signature, and there's no dedup logic yet, so `book.copies` will have length 1 (not 2) and/or a TypeScript error on the extra field.

- [ ] **Step 3: Extend `createBookWithCopyData`**

Modify `src/lib/books.ts`. Change the input type and function body:

```typescript
export async function createBookWithCopyData(
  input: { title: string; author: string; isbn: string; coverImagePath?: string } & CopyFieldsInput,
): Promise<{ bookId: string } | { error: string }> {
  const title = input.title.trim();
  const isbn = input.isbn.trim() || null;

  const parsedCopy = parseCopyFields(input);
  if ("error" in parsedCopy) {
    return parsedCopy;
  }

  const copyData = { ...parsedCopy, coverImagePath: input.coverImagePath ?? null };

  if (isbn) {
    const existingBook = await prisma.book.findFirst({ where: { isbn } });
    if (existingBook) {
      await prisma.physicalCopy.create({
        data: { ...copyData, bookId: existingBook.id },
      });
      return { bookId: existingBook.id };
    }
  }

  if (!title) {
    return { error: "Title is required" };
  }

  const book = await prisma.book.create({
    data: {
      title,
      author: input.author.trim() || null,
      isbn,
      copies: { create: copyData },
    },
  });

  return { bookId: book.id };
}
```

Note the reordered validation: the ISBN-dedup path is checked *before* the "title is required" check, because when attaching a copy to an already-existing book by ISBN match, the incoming `title` field (e.g. the OCR/Open-Library-prefilled title from a rescan) is irrelevant — the original book's title is authoritative and is never overwritten. This matches the test above ("original title preserved, not overwritten").

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run books.test`
Expected: PASS, including all previously-existing tests in this file (confirm the count — should be 7 original + 3 new = 10).

- [ ] **Step 5: Update the thin server-action wrapper**

Read `src/lib/actions/books.ts` first to confirm its current exact shape, then update `createBookWithCopy` to pass through the new optional field from form data:

```typescript
// in src/lib/actions/books.ts, inside createBookWithCopy, alongside the existing
// formData.get(...) calls for title/author/isbn/format/publisher/publishYear/specialNotes:
const coverImagePath = formData.get("coverImagePath")?.toString();

const result = await createBookWithCopyData({
  title: formData.get("title")?.toString() ?? "",
  author: formData.get("author")?.toString() ?? "",
  isbn: formData.get("isbn")?.toString() ?? "",
  format: formData.get("format")?.toString() ?? "",
  publisher: formData.get("publisher")?.toString() ?? "",
  publishYear: formData.get("publishYear")?.toString() ?? "",
  specialNotes: formData.get("specialNotes")?.toString() ?? "",
  coverImagePath: coverImagePath || undefined,
});
```

(Read the existing function body first — it very likely already destructures these fields from `formData` in this exact shape from Phase 2 Task 3; just add the one new field to the existing object literal rather than rewriting the whole function.)

- [ ] **Step 6: Verify it type-checks and existing tests still pass**

```bash
npx tsc --noEmit
npm test -- --run
```

Expected: zero type errors, all tests passing (should now be 18 total: the original 15 plus 3 new ones from Step 1).

- [ ] **Step 7: Commit**

```bash
git add src/lib/books.ts src/lib/books.test.ts src/lib/actions/books.ts
git commit -m "feat: support cover image and ISBN dedup on book creation"
```

---

### Task 5: BarcodeScanner client component

**Files:**
- Create: `src/components/BarcodeScanner.tsx`

- [ ] **Step 1: Write the component**

This component is not unit-tested (per the design spec's explicit note that camera/barcode behavior isn't practical to unit test) — instead it's kept small and single-purpose so its correctness can be verified by direct code review plus the live-verification step below, which uses a video *file* (not a live camera) so it's actually checkable without physical hardware.

```typescript
// src/components/BarcodeScanner.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, NotFoundException } from "@zxing/library";

interface BarcodeScannerProps {
  onDecode: (isbn: string, coverImageDataUrl: string) => void;
}

export function BarcodeScanner({ onDecode }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const hasDecodedRef = useRef(false);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader();
    let stopped = false;

    reader
      .decodeFromConstraints(
        { video: { facingMode: "environment" } },
        videoRef.current!,
        (result, err) => {
          if (stopped || hasDecodedRef.current) return;
          if (result) {
            const isbn = result.getText();
            const video = videoRef.current;
            if (!video) return;

            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(video, 0, 0);
            const dataUrl = canvas.toDataURL("image/png");

            hasDecodedRef.current = true;
            onDecode(isbn, dataUrl);
          } else if (err && !(err instanceof NotFoundException)) {
            setError(err.message);
          }
        },
      )
      .catch((err: Error) => {
        setError(err.message);
      });

    return () => {
      stopped = true;
      reader.reset();
    };
  }, [onDecode]);

  return (
    <div>
      {error && (
        <p className="text-sm text-red-600">
          Camera error: {error}. Try &quot;enter manually&quot; below instead.
        </p>
      )}
      <video ref={videoRef} className="w-full rounded" muted playsInline />
    </div>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify the decode logic against a pre-recorded barcode video (no live camera needed)**

`@zxing/library`'s `decodeFromConstraints` requires a live `getUserMedia` stream and can't be driven by a static test in Node, so this step is a live-in-browser check using Chrome's ability to feed a virtual camera from a video file — this is something you (the implementing agent) actually *can* do without physical hardware, unlike a real phone camera test:

1. Download or create a short video/GIF that shows a real EAN-13 barcode (e.g. record your own screen showing a barcode image on another device/monitor, or use any book's real barcode from a webcam-recorded clip) — if you cannot obtain one, skip to the fallback check below instead and note it plainly in your report; do not fabricate a "verified" claim.
2. In Chrome, launch with a fake video capture device pointed at that file: `chromium --use-fake-device-for-media-stream --use-file-for-fake-video-capture="/path/to/barcode-video.y4m"` (Chrome requires `.y4m` or `.mjpeg` — convert with `ffmpeg -i input.mp4 -pix_fmt yuv420p test.y4m` if needed).
3. Navigate to a throwaway test page that mounts `<BarcodeScanner onDecode={(isbn, img) => console.log(isbn, img.slice(0, 30))} />` and confirm the console logs a decoded ISBN and a `data:image/png;base64,...` prefix.

**Fallback if a barcode test video isn't obtainable in your environment:** verify instead that `getUserMedia`/`decodeFromConstraints` is invoked with the correct constraints and that the component cleans up (`reader.reset()`) on unmount, by reading the code carefully and confirming against the `@zxing/library` API docs (installed at `node_modules/@zxing/library/esm` — check `BrowserMultiFormatReader`'s method signatures directly). State explicitly in your report which of the two verification paths you used — do not claim the video-based check succeeded if you actually only did the fallback code review.

- [ ] **Step 4: Commit**

```bash
git add src/components/BarcodeScanner.tsx
git commit -m "feat: add barcode scanner component"
```

---

### Task 6: Cover picker component

**Files:**
- Create: `src/components/CoverPicker.tsx`

- [ ] **Step 1: Write the component**

A small, pure presentational component showing up to two candidate cover images (captured photo, Open Library cover) as selectable thumbnails, plus a hidden form field carrying the chosen one's data.

```typescript
// src/components/CoverPicker.tsx
"use client";

import { useState } from "react";

interface CoverPickerProps {
  capturedImageDataUrl: string | null;
  openLibraryCoverUrl: string | null;
  onRetake?: () => void;
}

export function CoverPicker({
  capturedImageDataUrl,
  openLibraryCoverUrl,
  onRetake,
}: CoverPickerProps) {
  const [selected, setSelected] = useState<"captured" | "openLibrary" | "none">(
    capturedImageDataUrl ? "captured" : openLibraryCoverUrl ? "openLibrary" : "none",
  );

  const selectedDataUrl =
    selected === "captured"
      ? capturedImageDataUrl
      : selected === "openLibrary"
        ? openLibraryCoverUrl
        : null;

  if (!capturedImageDataUrl && !openLibraryCoverUrl) {
    return null;
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium">Cover Image</p>
      <div className="flex gap-3">
        {capturedImageDataUrl && (
          <button
            type="button"
            onClick={() => setSelected("captured")}
            className={`rounded border-2 p-1 ${selected === "captured" ? "border-black" : "border-transparent"}`}
          >
            <img src={capturedImageDataUrl} alt="Your photo" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs">Your photo</p>
          </button>
        )}
        {openLibraryCoverUrl && (
          <button
            type="button"
            onClick={() => setSelected("openLibrary")}
            className={`rounded border-2 p-1 ${selected === "openLibrary" ? "border-black" : "border-transparent"}`}
          >
            <img src={openLibraryCoverUrl} alt="Open Library cover" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs">Open Library</p>
          </button>
        )}
      </div>
      {onRetake && capturedImageDataUrl && (
        <button type="button" onClick={onRetake} className="mt-2 text-sm underline">
          Retake photo
        </button>
      )}
      <input
        type="hidden"
        name="selectedCoverDataUrl"
        value={selectedDataUrl ?? ""}
      />
      <input
        type="hidden"
        name="selectedCoverSource"
        value={selected === "openLibrary" ? "url" : "dataUrl"}
      />
    </div>
  );
}
```

Note: `selectedCoverSource` distinguishes a captured-photo data URL (needs to go through `saveCoverImage` directly) from an Open Library URL (needs to be fetched server-side first, then saved) — this is consumed in Task 7's server action.

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/CoverPicker.tsx
git commit -m "feat: add cover picker component"
```

---

### Task 7: Scan-to-add page and server action

**Files:**
- Create: `src/app/books/scan/page.tsx`
- Create: `src/app/books/scan/ScanAddForm.tsx`
- Modify: `src/lib/actions/books.ts` (add `createBookFromScan` action)
- Modify: `src/lib/books.ts` (add a small helper to fetch+save an Open Library cover URL)

- [ ] **Step 1: Add a helper to fetch and persist an Open Library cover URL**

Add `import { saveCoverImage } from "@/lib/coverStorage";` to the top of `src/lib/books.ts` alongside the existing `import { prisma } from "@/lib/prisma";` line, then add this function:

```typescript
export async function saveCoverFromUrl(url: string): Promise<string> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return saveCoverImage(`data:${contentType};base64,${base64}`);
}
```

`books.ts` is a server-only module (only ever imported at runtime from server actions and route handlers — the two client components that reference it, `NewBookPage` and `EditBookForm`, both use `import type { BookFormState }`, which is erased at build time), so a plain top-level import here is safe and matches the rest of this file's style (e.g. `prisma` is imported the same way).

- [ ] **Step 2: Write the server action**

Add to `src/lib/actions/books.ts` (read the file first to match its existing imports/patterns exactly):

```typescript
export async function createBookFromScan(
  prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const selectedCoverDataUrl = formData.get("selectedCoverDataUrl")?.toString() ?? "";
  const selectedCoverSource = formData.get("selectedCoverSource")?.toString();

  let coverImagePath: string | undefined;
  if (selectedCoverDataUrl) {
    coverImagePath =
      selectedCoverSource === "url"
        ? await saveCoverFromUrl(selectedCoverDataUrl)
        : await saveCoverImage(selectedCoverDataUrl);
  }

  const result = await createBookWithCopyData({
    title: formData.get("title")?.toString() ?? "",
    author: formData.get("author")?.toString() ?? "",
    isbn: formData.get("isbn")?.toString() ?? "",
    format: formData.get("format")?.toString() ?? "",
    publisher: formData.get("publisher")?.toString() ?? "",
    publishYear: formData.get("publishYear")?.toString() ?? "",
    specialNotes: formData.get("specialNotes")?.toString() ?? "",
    coverImagePath,
  });

  if ("error" in result) {
    return { error: result.error };
  }

  const scanAnother = formData.get("scanAnother") === "true";
  revalidatePath("/books");
  redirect(scanAnother ? "/books/scan" : `/books/${result.bookId}`);
}
```

Add `saveCoverFromUrl` to the existing `import { createBookWithCopyData, ... } from "@/lib/books";` line at the top of the file, and add `import { saveCoverImage } from "@/lib/coverStorage";` alongside it. `actions/books.ts` is `"use server"` — server-only — so this top-level import is safe for the same reason noted in Step 1.

- [ ] **Step 3: Write the scan page**

```typescript
// src/app/books/scan/page.tsx
import { ScanAddForm } from "./ScanAddForm";

export default function ScanAddPage() {
  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-semibold">Scan a Book</h1>
      <ScanAddForm />
    </main>
  );
}
```

- [ ] **Step 4: Write the client form**

```typescript
// src/app/books/scan/ScanAddForm.tsx
"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createBookFromScan } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { CoverPicker } from "@/components/CoverPicker";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: BookFormState = {};

interface LookupData {
  title: string;
  author: string;
  publisher: string;
  publishYear: string;
  coverUrl: string | null;
}

export function ScanAddForm() {
  const [state, formAction, isPending] = useActionState(createBookFromScan, initialState);
  const [isbn, setIsbn] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [lookup, setLookup] = useState<LookupData | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);

  async function handleDecode(decodedIsbn: string, coverImageDataUrl: string) {
    setIsbn(decodedIsbn);
    setCapturedImage(coverImageDataUrl);
    setIsLookingUp(true);

    try {
      const response = await fetch(`/api/isbn-lookup?isbn=${encodeURIComponent(decodedIsbn)}`);
      const data = await response.json();
      setLookup({
        title: data.title ?? "",
        author: data.author ?? "",
        publisher: data.publisher ?? "",
        publishYear: data.publishYear?.toString() ?? "",
        coverUrl: data.coverUrl,
      });
    } catch {
      setLookup({ title: "", author: "", publisher: "", publishYear: "", coverUrl: null });
    } finally {
      setIsLookingUp(false);
    }
  }

  if (!isbn) {
    return (
      <div>
        <BarcodeScanner onDecode={handleDecode} />
        <Link href="/books/new" className="mt-4 inline-block text-sm underline">
          Enter manually instead
        </Link>
      </div>
    );
  }

  if (isLookingUp) {
    return <p>Looking up ISBN {isbn}...</p>;
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="isbn" value={isbn} />
      <div>
        <label htmlFor="title" className="block text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          name="title"
          required
          defaultValue={lookup?.title}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="author" className="block text-sm font-medium">
          Author
        </label>
        <input
          id="author"
          name="author"
          defaultValue={lookup?.author}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <CoverPicker
        capturedImageDataUrl={capturedImage}
        openLibraryCoverUrl={lookup?.coverUrl ?? null}
        onRetake={() => {
          setIsbn(null);
          setCapturedImage(null);
          setLookup(null);
        }}
      />
      <CopyFormFields defaultPublisher={lookup?.publisher} defaultPublishYear={lookup?.publishYear} />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="flex-1 rounded bg-black p-2 text-white disabled:opacity-50"
        >
          {isPending ? "Saving..." : "Save"}
        </button>
        <button
          type="submit"
          name="scanAnother"
          value="true"
          disabled={isPending}
          className="flex-1 rounded border border-black p-2 disabled:opacity-50"
        >
          Save &amp; Scan Another
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run the full test suite**

```bash
npm test -- --run
```

Expected: all passing (18 tests from before this task, no new tests added in this task since the page/form/action are exercised via live verification, not unit tests — consistent with how Phase 2's page-level React components were handled).

- [ ] **Step 7: Verify live (the parts that don't require a real camera)**

```bash
docker compose up -d postgres
npm run dev
```

Log in (password: check your local `.env`'s plaintext dev password from prior phases, or generate a fresh one per the README if unknown), then:

1. Navigate to `/books/scan` directly. Confirm the page loads, shows a video element (camera permission prompt appears in a real browser — grant it or deny it, both are fine to observe), and shows the "Enter manually instead" link.
2. Click "Enter manually instead" — confirm it navigates to `/books/new` (the existing Phase 2 flow, unchanged).
3. Since triggering a real barcode decode requires camera hardware you may not have, verify the **post-decode UI** works correctly by temporarily and only for this manual check — not as a permanent code change — calling `handleDecode("9780765326355", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")` from the browser devtools console against the live page (React DevTools lets you invoke component props/state setters, or you can temporarily add a dev-only test button — remove it before committing). Confirm:
   - A "Looking up ISBN..." message appears briefly.
   - The form appears pre-filled with "The Way of Kings" / "Brandon Sanderson" (real Open Library data for that real ISBN).
   - The `CoverPicker` shows two thumbnails (the tiny placeholder PNG you passed in, and the real Open Library cover image).
   - Selecting each thumbnail visually highlights it.
4. Submit the form with the default (first) cover selected. Confirm redirect to the new book's detail page, showing the cover image via `<img src="/api/covers/<filename>">` (check the Network tab / response headers show `Content-Type: image/png` or similar).
5. Go back to `/books/scan`, repeat the flow, this time click "Save & Scan Another" — confirm it redirects back to `/books/scan` (not the detail page).
6. Scan/simulate the *same* ISBN a second time — confirm this creates a **second copy on the same book** (not a duplicate book) per Task 4's dedup logic; check via the book's detail page showing 2 copies.
7. Clean up all test books/copies created via the UI.
8. Stop the dev server via targeted PID kill.

Explicitly note in your task report which steps required the devtools-console workaround (since a real camera wasn't available) versus genuine UI interaction — do not present the console-triggered path as "the user tapped a barcode with their camera and it worked," since that specific hardware path was not actually exercised.

- [ ] **Step 8: Commit**

```bash
git add src/app/books/scan/page.tsx src/app/books/scan/ScanAddForm.tsx src/lib/actions/books.ts src/lib/books.ts
git commit -m "feat: add scan-to-add-book page and server action"
```

---

### Task 8: Wire navigation and write the manual real-device QA checklist

**Files:**
- Modify: `src/app/books/page.tsx:` the "+ Add a book" link
- Create: `docs/superpowers/plans/2026-07-06-phase3-manual-qa-checklist.md`

- [ ] **Step 1: Point the primary "Add a book" link at the scan flow**

Read `src/app/books/page.tsx` first to find the exact current link markup (from Phase 2 Task 6), which currently points to `/books/new`. Change its `href` to `/books/scan`, keeping everything else (text, className) the same, so scanning becomes the primary entry point and manual entry remains one click away via the link added in Task 7.

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

```bash
npm run dev
```

Log in, navigate to `/books`, click "+ Add a book", confirm it now lands on `/books/scan` instead of `/books/new`. Confirm `/books/new` is still directly reachable (typed in the URL bar, or via the "Enter manually instead" link from `/books/scan`) and still works exactly as it did at the end of Phase 2. Stop the dev server via targeted PID kill.

- [ ] **Step 4: Write the manual real-device QA checklist**

This phase's camera/barcode behavior genuinely cannot be verified by an agent without physical hardware. Write this checklist file so the user has a concrete, complete list to run through themselves on an actual iOS and Android device before considering the phase fully done:

```markdown
# Phase 3 Manual QA Checklist (real device required)

Run through this on both an iOS Safari device and an Android Chrome device.
Agents implementing this plan cannot complete this checklist themselves — it
requires real camera hardware.

- [ ] Open `/books/scan` on the phone. Camera permission prompt appears;
      grant it. Live camera feed shows in the page.
- [ ] Point the camera at a real book's barcode (EAN-13, the one under the
      regular UPC barcode on most books). Confirm it decodes within a few
      seconds without needing to hold unnaturally still.
- [ ] Confirm a photo of your actual book cover was captured (shown as one
      of the two cover choices) and it's not blank/black/blurry-unusable.
- [ ] Confirm the Open Library cover (if that ISBN has one) appears as the
      second choice, and you can toggle between the two.
- [ ] Confirm title/author/publisher/year are pre-filled correctly for a
      well-known book.
- [ ] Scan a book Open Library has no data for (try a small-press or very
      old book) — confirm the form still opens with just the ISBN and your
      captured photo, fields blank, no crash/error dialog.
- [ ] Deny camera permission (or test on a device/browser without camera
      access) — confirm the page shows a clear error and the "enter
      manually instead" link still works.
- [ ] Scan a book you already own (same ISBN as one already in the
      catalog) — confirm it adds a second copy to the existing book entry
      rather than creating a duplicate book.
- [ ] Use "Save & Scan Another" after saving — confirm it returns straight
      to the camera view without extra navigation taps.
- [ ] Confirm the whole flow is usable one-handed while holding a stack of
      books (this was the original motivating use case) — not a pass/fail
      check, just a feel/usability note.
```

- [ ] **Step 5: Commit**

```bash
git add src/app/books/page.tsx docs/superpowers/plans/2026-07-06-phase3-manual-qa-checklist.md
git commit -m "feat: make barcode scan the primary add-book entry point"
```

---

## Phase 3 capstone verification (after all 8 tasks)

Before merging, in addition to the per-task verification above, run:

```bash
npm test -- --run
npx tsc --noEmit
npx next build
```

Confirm the build output shows `/books/scan` and `/api/isbn-lookup` and `/api/covers/[filename]` and `/api/isbn-lookup` as dynamic (`ƒ`) routes (they all read live request data / call external services, so none should be statically prerendered) — this is the same category of check that caught a real bug at the end of Phase 1 and should be repeated here.

Then hand the checklist from Task 8 Step 4 to the user for real-device verification — **this phase should not be considered fully done, even after merge, until that checklist has actually been run on a real phone**, since no automated or subagent-driven check in this plan can substitute for it.
