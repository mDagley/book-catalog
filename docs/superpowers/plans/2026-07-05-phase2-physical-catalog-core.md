# Book Catalog — Phase 2: Physical Catalog Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manual add/edit/delete for physical books and their copies, plus a
searchable list view — the first real, usable feature of the catalog (no
barcode scanning yet; that's Phase 3).

**Architecture:** A pure, testable data layer (`src/lib/books.ts`,
`src/lib/copies.ts`) wrapping Prisma calls with validation, kept separate
from thin Next.js Server Action wrappers (`src/lib/actions/*.ts`) that add
`redirect()`/`revalidatePath()` — this split exists because
`next/navigation`'s `redirect()` throws internally and can't be unit-tested
outside a real request context, so the testable logic lives one layer down.
Forms use React 19's `useActionState` for pending/error state without any
client-side fetch boilerplate. Pages are server components by default;
forms are client components.

**Tech Stack:** Next.js Server Actions, React 19 `useActionState`, Prisma
(existing `Book`/`PhysicalCopy` models from Phase 1), Vitest against the
real local Postgres (matching the project's existing testing approach —
no mocking library).

---

## File Structure

```
src/
├── lib/
│   ├── books.ts                          # pure data layer: create/update book+copy
│   ├── books.test.ts
│   ├── copies.ts                         # pure data layer: add/update/delete copy
│   ├── copies.test.ts
│   └── actions/
│       ├── books.ts                      # "use server" wrappers: redirect/revalidate
│       └── copies.ts                     # "use server" wrappers: redirect/revalidate
├── components/
│   └── CopyFormFields.tsx                # shared format/publisher/year/notes fields
└── app/
    ├── page.tsx                          # modify: add a link to /books
    └── books/
        ├── page.tsx                      # list + search
        ├── new/
        │   └── page.tsx                  # add book form (client component)
        └── [id]/
            ├── page.tsx                  # book detail (copies list)
            ├── edit/
            │   ├── page.tsx              # server: fetches book, renders form
            │   └── EditBookForm.tsx      # client: the actual form
            └── copies/
                ├── new/
                │   ├── page.tsx          # server: fetches book, renders form
                │   └── AddCopyForm.tsx   # client: the actual form
                └── [copyId]/
                    └── edit/
                        ├── page.tsx           # server: fetches copy, renders form
                        └── EditCopyForm.tsx   # client: the actual form
```

Note: `books/new/page.tsx` is a client component directly (no server/client
split needed there, since it doesn't need to fetch existing data first —
unlike edit and add-copy, which need a server component to load data before
rendering the client form).

---

### Task 1: Book Data Layer

**Files:**
- Create: `src/lib/books.ts`
- Test: `src/lib/books.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/books.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createBookWithCopyData, updateBookData } from "@/lib/books";

const createdBookIds: string[] = [];

afterEach(async () => {
  for (const id of createdBookIds) {
    await prisma.book.deleteMany({ where: { id } });
  }
  createdBookIds.length = 0;
});

describe("createBookWithCopyData", () => {
  it("creates a book with an initial copy", async () => {
    const result = await createBookWithCopyData({
      title: "Test Book",
      author: "Test Author",
      isbn: "1234567890",
      format: "HARDCOVER",
      publisher: "Test Publisher",
      publishYear: "2020",
      specialNotes: "Signed",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    createdBookIds.push(result.bookId);

    const book = await prisma.book.findUnique({
      where: { id: result.bookId },
      include: { copies: true },
    });
    expect(book?.title).toBe("Test Book");
    expect(book?.author).toBe("Test Author");
    expect(book?.isbn).toBe("1234567890");
    expect(book?.copies).toHaveLength(1);
    expect(book?.copies[0].format).toBe("HARDCOVER");
    expect(book?.copies[0].publisher).toBe("Test Publisher");
    expect(book?.copies[0].publishYear).toBe(2020);
    expect(book?.copies[0].specialNotes).toBe("Signed");
  });

  it("treats empty optional fields as null, not empty strings", async () => {
    const result = await createBookWithCopyData({
      title: "Minimal Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    createdBookIds.push(result.bookId);

    const book = await prisma.book.findUnique({
      where: { id: result.bookId },
      include: { copies: true },
    });
    expect(book?.author).toBeNull();
    expect(book?.isbn).toBeNull();
    expect(book?.copies[0].publisher).toBeNull();
    expect(book?.copies[0].publishYear).toBeNull();
    expect(book?.copies[0].specialNotes).toBeNull();
  });

  it("returns an error when title is empty or whitespace-only", async () => {
    const result = await createBookWithCopyData({
      title: "   ",
      author: "",
      isbn: "",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "Title is required" });
  });

  it("returns an error when format is invalid", async () => {
    const result = await createBookWithCopyData({
      title: "Test Book",
      author: "",
      isbn: "",
      format: "INVALID_FORMAT",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "A valid format is required" });
  });

  it("returns an error when publish year is not a number", async () => {
    const result = await createBookWithCopyData({
      title: "Test Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "not-a-year",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "Publish year must be a number" });
  });
});

describe("updateBookData", () => {
  async function createTestBook() {
    const created = await createBookWithCopyData({
      title: "Original Title",
      author: "",
      isbn: "",
      format: "OTHER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    if ("error" in created) throw new Error("test setup failed");
    createdBookIds.push(created.bookId);
    return created.bookId;
  }

  it("updates a book's title/author/isbn", async () => {
    const bookId = await createTestBook();

    const result = await updateBookData(bookId, {
      title: "Updated Title",
      author: "New Author",
      isbn: "9999999999",
    });

    expect(result).toEqual({ ok: true });
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    expect(book?.title).toBe("Updated Title");
    expect(book?.author).toBe("New Author");
    expect(book?.isbn).toBe("9999999999");
  });

  it("returns an error when title is empty", async () => {
    const bookId = await createTestBook();
    const result = await updateBookData(bookId, { title: "", author: "", isbn: "" });
    expect(result).toEqual({ error: "Title is required" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- books.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/books'" (or similar — the
module doesn't exist yet).

- [ ] **Step 3: Write the data layer**

```typescript
// src/lib/books.ts
import { prisma } from "@/lib/prisma";

export interface BookFormState {
  error?: string;
}

export const VALID_FORMATS = ["HARDCOVER", "PAPERBACK", "MASS_MARKET", "OTHER"] as const;
export type BookFormat = (typeof VALID_FORMATS)[number];

interface CopyFieldsInput {
  format: string;
  publisher: string;
  publishYear: string;
  specialNotes: string;
}

interface ParsedCopyFields {
  format: BookFormat;
  publisher: string | null;
  publishYear: number | null;
  specialNotes: string | null;
}

export function parseCopyFields(
  input: CopyFieldsInput,
): ParsedCopyFields | { error: string } {
  if (!VALID_FORMATS.includes(input.format as BookFormat)) {
    return { error: "A valid format is required" };
  }

  let publishYear: number | null = null;
  if (input.publishYear.trim()) {
    publishYear = parseInt(input.publishYear, 10);
    if (Number.isNaN(publishYear)) {
      return { error: "Publish year must be a number" };
    }
  }

  return {
    format: input.format as BookFormat,
    publisher: input.publisher.trim() || null,
    publishYear,
    specialNotes: input.specialNotes.trim() || null,
  };
}

export async function createBookWithCopyData(
  input: { title: string; author: string; isbn: string } & CopyFieldsInput,
): Promise<{ bookId: string } | { error: string }> {
  const title = input.title.trim();
  if (!title) {
    return { error: "Title is required" };
  }

  const parsedCopy = parseCopyFields(input);
  if ("error" in parsedCopy) {
    return parsedCopy;
  }

  const book = await prisma.book.create({
    data: {
      title,
      author: input.author.trim() || null,
      isbn: input.isbn.trim() || null,
      copies: { create: parsedCopy },
    },
  });

  return { bookId: book.id };
}

export async function updateBookData(
  bookId: string,
  input: { title: string; author: string; isbn: string },
): Promise<{ ok: true } | { error: string }> {
  const title = input.title.trim();
  if (!title) {
    return { error: "Title is required" };
  }

  await prisma.book.update({
    where: { id: bookId },
    data: {
      title,
      author: input.author.trim() || null,
      isbn: input.isbn.trim() || null,
    },
  });

  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- books.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/books.ts src/lib/books.test.ts
git commit -m "feat: add book data layer with create/update"
```

---

### Task 2: Copy Data Layer

**Files:**
- Create: `src/lib/copies.ts`
- Test: `src/lib/copies.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/copies.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createBookWithCopyData } from "@/lib/books";
import { addCopyData, updateCopyData, deleteCopyData } from "@/lib/copies";

const createdBookIds: string[] = [];

afterEach(async () => {
  for (const id of createdBookIds) {
    await prisma.book.deleteMany({ where: { id } });
  }
  createdBookIds.length = 0;
});

async function createTestBook() {
  const created = await createBookWithCopyData({
    title: "Test Book For Copies",
    author: "",
    isbn: "",
    format: "PAPERBACK",
    publisher: "",
    publishYear: "",
    specialNotes: "",
  });
  if ("error" in created) throw new Error("test setup failed");
  createdBookIds.push(created.bookId);
  return created.bookId;
}

describe("addCopyData", () => {
  it("adds a second copy to an existing book", async () => {
    const bookId = await createTestBook();

    const result = await addCopyData(bookId, {
      format: "HARDCOVER",
      publisher: "Second Publisher",
      publishYear: "2015",
      specialNotes: "First edition",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    const copies = await prisma.physicalCopy.findMany({ where: { bookId } });
    expect(copies).toHaveLength(2);
    const newCopy = copies.find((c) => c.id === result.copyId);
    expect(newCopy?.format).toBe("HARDCOVER");
    expect(newCopy?.publisher).toBe("Second Publisher");
    expect(newCopy?.publishYear).toBe(2015);
  });

  it("returns an error when format is invalid", async () => {
    const bookId = await createTestBook();
    const result = await addCopyData(bookId, {
      format: "NOT_A_FORMAT",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "A valid format is required" });
  });
});

describe("updateCopyData", () => {
  it("updates a copy's fields", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await updateCopyData(existingCopy.id, {
      format: "MASS_MARKET",
      publisher: "Updated Publisher",
      publishYear: "1999",
      specialNotes: "Water damaged",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.physicalCopy.findUnique({ where: { id: existingCopy.id } });
    expect(updated?.format).toBe("MASS_MARKET");
    expect(updated?.publisher).toBe("Updated Publisher");
    expect(updated?.publishYear).toBe(1999);
    expect(updated?.specialNotes).toBe("Water damaged");
  });

  it("returns an error when format is invalid", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await updateCopyData(existingCopy.id, {
      format: "NOT_A_FORMAT",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "A valid format is required" });
  });
});

describe("deleteCopyData", () => {
  it("deletes a copy but keeps the book when other copies remain", async () => {
    const bookId = await createTestBook();
    const addResult = await addCopyData(bookId, {
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    if ("error" in addResult) throw new Error("test setup failed");

    const result = await deleteCopyData(addResult.copyId);

    expect(result).toEqual({ bookId, bookDeleted: false });
    const remainingCopies = await prisma.physicalCopy.findMany({ where: { bookId } });
    expect(remainingCopies).toHaveLength(1);
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    expect(book).not.toBeNull();
  });

  it("deletes the book too when its last copy is removed", async () => {
    const bookId = await createTestBook();
    const [onlyCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await deleteCopyData(onlyCopy.id);

    expect(result).toEqual({ bookId, bookDeleted: true });
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    expect(book).toBeNull();
    // Remove from cleanup list since it's already gone
    const idx = createdBookIds.indexOf(bookId);
    if (idx !== -1) createdBookIds.splice(idx, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- copies.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/copies'".

- [ ] **Step 3: Write the data layer**

```typescript
// src/lib/copies.ts
import { prisma } from "@/lib/prisma";
import { parseCopyFields } from "@/lib/books";

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
  input: CopyFieldsInput,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseCopyFields(input);
  if ("error" in parsed) {
    return parsed;
  }

  await prisma.physicalCopy.update({
    where: { id: copyId },
    data: parsed,
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
    await prisma.book.delete({ where: { id: copy.bookId } });
    return { bookId: copy.bookId, bookDeleted: true };
  }

  return { bookId: copy.bookId, bookDeleted: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- copies.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/copies.ts src/lib/copies.test.ts
git commit -m "feat: add copy data layer with add/update/delete"
```

---

### Task 3: Book Server Actions

**Files:**
- Create: `src/lib/actions/books.ts`

- [ ] **Step 1: Write the server actions**

```typescript
// src/lib/actions/books.ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createBookWithCopyData, updateBookData, type BookFormState } from "@/lib/books";

export async function createBookWithCopy(
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const result = await createBookWithCopyData({
    title: (formData.get("title") as string) ?? "",
    author: (formData.get("author") as string) ?? "",
    isbn: (formData.get("isbn") as string) ?? "",
    format: (formData.get("format") as string) ?? "",
    publisher: (formData.get("publisher") as string) ?? "",
    publishYear: (formData.get("publishYear") as string) ?? "",
    specialNotes: (formData.get("specialNotes") as string) ?? "",
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath("/books");
  redirect(`/books/${result.bookId}`);
}

export async function updateBook(
  bookId: string,
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const result = await updateBookData(bookId, {
    title: (formData.get("title") as string) ?? "",
    author: (formData.get("author") as string) ?? "",
    isbn: (formData.get("isbn") as string) ?? "",
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors. Note: `redirect()` and `revalidatePath()` are
Next.js-request-context-dependent and are NOT covered by Vitest unit tests
(that's why the actual data logic was extracted to `src/lib/books.ts` in
Task 1) — these action wrappers are verified via live manual testing once
the pages exist (Tasks 6-9).

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/books.ts
git commit -m "feat: add book server actions"
```

---

### Task 4: Copy Server Actions

**Files:**
- Create: `src/lib/actions/copies.ts`

- [ ] **Step 1: Write the server actions**

```typescript
// src/lib/actions/copies.ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
}

export async function deleteCopy(copyId: string, _formData: FormData): Promise<void> {
  const { bookId, bookDeleted } = await deleteCopyData(copyId);

  if (bookDeleted) {
    revalidatePath("/books");
    redirect("/books");
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/actions/copies.ts
git commit -m "feat: add copy server actions"
```

---

### Task 5: Shared Copy Form Fields Component

**Files:**
- Create: `src/components/CopyFormFields.tsx`

- [ ] **Step 1: Write the component**

```typescript
// src/components/CopyFormFields.tsx
export const FORMAT_OPTIONS = [
  { value: "HARDCOVER", label: "Hardcover" },
  { value: "PAPERBACK", label: "Paperback" },
  { value: "MASS_MARKET", label: "Mass Market" },
  { value: "OTHER", label: "Other" },
] as const;

export const FORMAT_LABELS: Record<string, string> = Object.fromEntries(
  FORMAT_OPTIONS.map((opt) => [opt.value, opt.label]),
);

interface CopyFormFieldsProps {
  defaultFormat?: string;
  defaultPublisher?: string;
  defaultPublishYear?: string;
  defaultSpecialNotes?: string;
}

export function CopyFormFields({
  defaultFormat = "",
  defaultPublisher = "",
  defaultPublishYear = "",
  defaultSpecialNotes = "",
}: CopyFormFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="format" className="block text-sm font-medium">
          Format
        </label>
        <select
          id="format"
          name="format"
          required
          defaultValue={defaultFormat}
          className="mt-1 w-full rounded border p-2"
        >
          <option value="">Select a format</option>
          {FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="publisher" className="block text-sm font-medium">
          Publisher
        </label>
        <input
          id="publisher"
          name="publisher"
          defaultValue={defaultPublisher}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="publishYear" className="block text-sm font-medium">
          Publish Year
        </label>
        <input
          id="publishYear"
          name="publishYear"
          type="number"
          defaultValue={defaultPublishYear}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="specialNotes" className="block text-sm font-medium">
          Special Notes
        </label>
        <textarea
          id="specialNotes"
          name="specialNotes"
          defaultValue={defaultSpecialNotes}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
    </>
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
git add src/components/CopyFormFields.tsx
git commit -m "feat: add shared copy form fields component"
```

---

### Task 6: Books List Page (Search)

**Files:**
- Create: `src/app/books/page.tsx`

- [ ] **Step 1: Write the list/search page**

```typescript
// src/app/books/page.tsx
import Link from "next/link";
import { prisma } from "@/lib/prisma";

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() || "";

  const books = await prisma.book.findMany({
    where: query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { author: { contains: query, mode: "insensitive" } },
            { isbn: { contains: query, mode: "insensitive" } },
          ],
        }
      : undefined,
    include: { copies: true },
    orderBy: { title: "asc" },
  });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Physical Books</h1>
        <Link href="/books/new" className="rounded bg-black px-3 py-2 text-sm text-white">
          + Add a book
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4">
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
          className="w-full rounded border p-2"
        />
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

**Toolchain note:** `searchParams` as a `Promise` is the established
Next.js App Router pattern since v15, continued in v16 — confirmed already
in use in this project's conventions. If `npx tsc --noEmit` complains about
this shape, check `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`
for the current expected signature and adapt, flagging any deviation.

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

Start the stack and manually check the page renders (empty state, since no
books exist yet):

```bash
docker compose up -d postgres
npm run dev
```

Log in (password `BLOdfFwo7BnnLxe2`), then visit `http://localhost:3000/books`
(or via curl with a session cookie jar, or Playwright if available in this
environment). Expected: "Physical Books" heading, "+ Add a book" link,
search box, and "No books found." (empty state, since no books exist yet —
this will be populated once Task 7 exists).

Stop the dev server cleanly (targeted PID kill via netstat, not broad
taskkill) when done.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/page.tsx
git commit -m "feat: add books list page with search"
```

---

### Task 7: Add Book Page

**Files:**
- Create: `src/app/books/new/page.tsx`

- [ ] **Step 1: Write the add-book form page**

```typescript
// src/app/books/new/page.tsx
"use client";

import { useActionState } from "react";
import { createBookWithCopy } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: BookFormState = {};

export default function NewBookPage() {
  const [state, formAction, isPending] = useActionState(createBookWithCopy, initialState);

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-semibold">Add a Book</h1>
      <form action={formAction} className="space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium">
            Title
          </label>
          <input id="title" name="title" required className="mt-1 w-full rounded border p-2" />
        </div>
        <div>
          <label htmlFor="author" className="block text-sm font-medium">
            Author
          </label>
          <input id="author" name="author" className="mt-1 w-full rounded border p-2" />
        </div>
        <div>
          <label htmlFor="isbn" className="block text-sm font-medium">
            ISBN
          </label>
          <input id="isbn" name="isbn" className="mt-1 w-full rounded border p-2" />
        </div>

        <CopyFormFields />

        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
        >
          {isPending ? "Saving..." : "Save"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Using Playwright if available (this environment has had it work in prior
tasks via a temporary `npm install --no-save playwright`, removed
afterward — use the same approach if not already present; if genuinely
unavailable, fall back to curl with a cookie jar for the initial page load
plus careful code review of the client-side logic, same as prior tasks'
documented fallback), log in and:

1. Visit `/books/new` — form renders with all fields.
2. Submit with title empty — expect the browser's native "required" field
   validation to block submission (the `title` input has `required`).
3. Submit with a title but no format selected — expect `state.error` to
   show "A valid format is required" (format select also has `required`,
   so the browser blocks it too — to actually exercise the server-side
   validation path, you'll need to bypass the browser's own required-field
   check, e.g. via Playwright's `page.evaluate` to remove the `required`
   attribute before submitting, or by directly POSTing to test the action).
4. Submit with title "Test Verification Book", format "Paperback" — expect
   redirect to `/books/<new-id>` (a 404 for now, since Task 8 doesn't exist
   yet — that's fine, just confirm the redirect happens to the right URL
   pattern).
5. Manually verify via `docker compose exec postgres psql -U bookcatalog -d bookcatalog -c "SELECT title FROM \"Book\" WHERE title = 'Test Verification Book';"`
   that the book was actually created, then delete it:
   `docker compose exec postgres psql -U bookcatalog -d bookcatalog -c "DELETE FROM \"Book\" WHERE title = 'Test Verification Book';"`
   (the `PhysicalCopy` row cascades... actually check: there is NO cascade
   delete configured in the schema, so delete the copy first:
   `docker compose exec postgres psql -U bookcatalog -d bookcatalog -c "DELETE FROM \"PhysicalCopy\" WHERE \"bookId\" IN (SELECT id FROM \"Book\" WHERE title = 'Test Verification Book');"`
   then delete the book).

Stop the dev server cleanly when done.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/new/page.tsx
git commit -m "feat: add new book form page"
```

---

### Task 8: Book Detail Page

**Files:**
- Create: `src/app/books/[id]/page.tsx`

- [ ] **Step 1: Write the detail page**

```typescript
// src/app/books/[id]/page.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deleteCopy } from "@/lib/actions/copies";
import { FORMAT_LABELS } from "@/components/CopyFormFields";

export default async function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({
    where: { id },
    include: { copies: { orderBy: { createdAt: "asc" } } },
  });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{book.title}</h1>
          {book.author && <p className="text-gray-600">{book.author}</p>}
          {book.isbn && <p className="text-sm text-gray-500">ISBN: {book.isbn}</p>}
        </div>
        <Link href={`/books/${book.id}/edit`} className="rounded border px-3 py-2 text-sm">
          Edit
        </Link>
      </div>

      <div className="mb-4 flex items-center justify-between">
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
    </main>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, then:

1. Visit `/books/new`, create a test book ("Detail Page Test Book",
   Paperback format).
2. Confirm redirect lands on `/books/<id>` and the page now renders
   correctly: title, format label "Paperback" (not the raw enum
   `PAPERBACK`), an "Edit" link, and a "+ Add a copy" link.
3. Click/submit the "Delete" form for the only copy — confirm it redirects
   to `/books` (since deleting the last copy deletes the book too, per
   Task 2/4's `deleteCopyData`/`deleteCopy` behavior) and the book no
   longer appears in the list.
4. Visit `/books/<some-random-nonexistent-id>` — confirm a 404 page
   renders (via Next's `notFound()`).

Stop the dev server cleanly when done.

- [ ] **Step 4: Commit**

```bash
git add "src/app/books/[id]/page.tsx"
git commit -m "feat: add book detail page with copies list"
```

---

### Task 9: Edit Book Page

**Files:**
- Create: `src/app/books/[id]/edit/page.tsx`

- [ ] **Step 1: Write the edit-book form page**

This needs both a server component (to fetch the existing book data) and a
client component (for the form itself, since `useActionState` requires
client-side React). Split into a server page that fetches data and renders
a client form component inline in the same file using a nested component —
but Next.js requires an entire file to be `"use client"` or not; since this
page needs to `await params` (server-only) AND use `useActionState`
(client-only), split into two files.

**Files (revised):**
- Create: `src/app/books/[id]/edit/page.tsx` (server component, fetches data)
- Create: `src/app/books/[id]/edit/EditBookForm.tsx` (client component, the form)

```typescript
// src/app/books/[id]/edit/page.tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditBookForm } from "./EditBookForm";

export default async function EditBookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({ where: { id } });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 text-2xl font-semibold">Edit Book</h1>
      <EditBookForm
        bookId={book.id}
        defaultTitle={book.title}
        defaultAuthor={book.author ?? ""}
        defaultIsbn={book.isbn ?? ""}
      />
    </main>
  );
}
```

```typescript
// src/app/books/[id]/edit/EditBookForm.tsx
"use client";

import { useActionState } from "react";
import { updateBook } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";

const initialState: BookFormState = {};

interface EditBookFormProps {
  bookId: string;
  defaultTitle: string;
  defaultAuthor: string;
  defaultIsbn: string;
}

export function EditBookForm({
  bookId,
  defaultTitle,
  defaultAuthor,
  defaultIsbn,
}: EditBookFormProps) {
  const updateBookWithId = updateBook.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(updateBookWithId, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="title" className="block text-sm font-medium">
          Title
        </label>
        <input
          id="title"
          name="title"
          required
          defaultValue={defaultTitle}
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
          defaultValue={defaultAuthor}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor="isbn" className="block text-sm font-medium">
          ISBN
        </label>
        <input
          id="isbn"
          name="isbn"
          defaultValue={defaultIsbn}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
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

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, create a test book via `/books/new` ("Edit Page Test Book"), note
its ID from the redirect URL, then:

1. Visit `/books/<id>/edit` — confirm the form is pre-filled with the
   correct title/author/isbn.
2. Change the title to "Edit Page Test Book (Updated)" and submit —
   confirm redirect to `/books/<id>` and the detail page shows the new
   title.
3. Clean up: delete the test book's copy via the detail page's delete
   button (which cascades to deleting the book, per Task 8's verified
   behavior).

Stop the dev server cleanly when done.

- [ ] **Step 4: Commit**

```bash
git add "src/app/books/[id]/edit/page.tsx" "src/app/books/[id]/edit/EditBookForm.tsx"
git commit -m "feat: add edit book page"
```

---

### Task 10: Add Copy Page

**Files:**
- Create: `src/app/books/[id]/copies/new/page.tsx` (server component)
- Create: `src/app/books/[id]/copies/new/AddCopyForm.tsx` (client component)

- [ ] **Step 1: Write the add-copy pages**

```typescript
// src/app/books/[id]/copies/new/page.tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AddCopyForm } from "./AddCopyForm";

export default async function AddCopyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({ where: { id } });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 text-2xl font-semibold">Add a Copy</h1>
      <p className="mb-4 text-gray-600">{book.title}</p>
      <AddCopyForm bookId={book.id} />
    </main>
  );
}
```

```typescript
// src/app/books/[id]/copies/new/AddCopyForm.tsx
"use client";

import { useActionState } from "react";
import { addCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: CopyFormState = {};

export function AddCopyForm({ bookId }: { bookId: string }) {
  const addCopyForBook = addCopy.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(addCopyForBook, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields />
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

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, create a test book via `/books/new` ("Add Copy Test Book"), then:

1. From the detail page, click "+ Add a copy" — confirm it navigates to
   `/books/<id>/copies/new` and shows the book's title plus the copy form.
2. Submit with format "Hardcover" — confirm redirect back to `/books/<id>`
   and the detail page now shows 2 copies.
3. Clean up: delete both copies via the detail page (deleting the last one
   removes the book).

Stop the dev server cleanly when done.

- [ ] **Step 4: Commit**

```bash
git add "src/app/books/[id]/copies/new/page.tsx" "src/app/books/[id]/copies/new/AddCopyForm.tsx"
git commit -m "feat: add copy-to-existing-book page"
```

---

### Task 11: Edit Copy Page

**Files:**
- Create: `src/app/books/[id]/copies/[copyId]/edit/page.tsx` (server component)
- Create: `src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx` (client component)

- [ ] **Step 1: Write the edit-copy pages**

```typescript
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
      />
    </main>
  );
}
```

```typescript
// src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx
"use client";

import { useActionState } from "react";
import { updateCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";

const initialState: CopyFormState = {};

interface EditCopyFormProps {
  copyId: string;
  bookId: string;
  defaultFormat: string;
  defaultPublisher: string;
  defaultPublishYear: string;
  defaultSpecialNotes: string;
}

export function EditCopyForm({
  copyId,
  bookId,
  defaultFormat,
  defaultPublisher,
  defaultPublishYear,
  defaultSpecialNotes,
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

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, create a test book via `/books/new` ("Edit Copy Test Book",
Paperback), then:

1. From the detail page, click "Edit" next to the copy — confirm the form
   is pre-filled with "Paperback" selected and the other fields correct.
2. Change format to "Hardcover" and submit — confirm redirect to
   `/books/<id>` and the detail page now shows "Hardcover".
3. Visit `/books/<id>/copies/<some-other-books-copy-id>/edit` (a copy ID
   that belongs to a DIFFERENT book than `<id>`) — confirm this returns a
   404, proving the `copy.bookId !== id` guard in Step 1 works (this
   guards against a URL where the two path segments don't actually belong
   together).
4. Clean up: delete the test book via the detail page.

Stop the dev server cleanly when done.

- [ ] **Step 4: Commit**

```bash
git add "src/app/books/[id]/copies/[copyId]/edit/page.tsx" "src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx"
git commit -m "feat: add edit copy page"
```

---

### Task 12: Link Home Page to Books

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Add a link to /books**

Read the current file first (`src/app/page.tsx` from Phase 1) — it should
currently look like:

```typescript
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const bookCount = await prisma.book.count();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4">
      <h1 className="text-2xl font-semibold">Book Catalog</h1>
      <p className="mt-2 text-gray-600">{bookCount} books in catalog</p>
      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm underline">
          Log out
        </button>
      </form>
    </main>
  );
}
```

Add a link to `/books` between the count and the logout form:

```typescript
import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const bookCount = await prisma.book.count();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4">
      <h1 className="text-2xl font-semibold">Book Catalog</h1>
      <p className="mt-2 text-gray-600">{bookCount} books in catalog</p>
      <Link href="/books" className="mt-4 rounded bg-black px-4 py-2 text-white">
        View Physical Books
      </Link>
      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm underline">
          Log out
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Verify live**

```bash
docker compose up -d postgres
npm run dev
```

Log in, confirm the home page now shows a "View Physical Books" link, and
clicking it navigates to `/books`.

Stop the dev server cleanly when done.

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: link home page to physical books list"
```

---

## Phase 2 Complete

At this point: full manual CRUD for physical books and their copies — add
a book (with its first copy), add additional copies to an existing book,
edit book details, edit copy details, delete a copy (cascading to delete
the book when its last copy is removed), and a searchable list view. No
barcode scanning or cover images yet (Phase 3), no ABS integration yet
(Phase 4).

Each subsequent phase (3, 4, 5, 6) still gets its own fully-detailed plan
document written via this same process when reached, per the phasing
approach established in Phase 1.
