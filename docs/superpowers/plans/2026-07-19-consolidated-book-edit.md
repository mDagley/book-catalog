# Consolidated Book Edit Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/books/[id]/edit` the single place to edit everything about a book — title/author/isbn (already there), readStatus/rating (currently only on the detail page), and every physical/ebook/audiobook copy's fields (currently one page per copy) — removing the now-redundant standalone copy-edit routes.

**Architecture:** Every field this plan touches already has a working update action (`updateBook`, `updateCopy`, `updateEbookCopyCover`, `updateAudiobookCopyCover`, `updateReadStatus`, `updateRating`, `clearReadStatusManual`, `clearRatingManual`) and an existing form component. This plan is page composition, not new business logic: the three copy-edit form components move from their route-local directories to `src/components/` so they can be rendered inline (once per existing copy) on the consolidated page instead of on their own routes; `CopyFormFields` gains an `idPrefix` prop so multiple physical-copy sections on one page don't produce colliding DOM ids; four server actions' post-save `redirect()` target changes from the book detail page to the edit page, so saving any section keeps you on the consolidated page instead of bouncing away from it (this app has no automated Next.js page-rendering tests — verification for the page-composition tasks is a real dev-server + Playwright walkthrough, matching how UI changes are already verified in this project).

**Tech Stack:** Next.js App Router (Server Components + Server Actions), TypeScript, Vitest (`environment: "node"`, no jsdom/testing-library — confirmed `react-dom/server`'s `renderToStaticMarkup` works out of the box for the one test in this plan that needs to render JSX).

---

## Design spec

Full rationale: `docs/superpowers/specs/2026-07-19-consolidated-book-edit-design.md`. Read it before starting.

## Task 1: `CopyFormFields` gains an `idPrefix` prop

**Files:**
- Modify: `src/components/CopyFormFields.tsx`
- Test: `src/components/CopyFormFields.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

Create `src/components/CopyFormFields.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyFormFields } from "@/components/CopyFormFields";

describe("CopyFormFields", () => {
  it("uses unprefixed ids by default, matching the single-instance-per-page callers", () => {
    const html = renderToStaticMarkup(<CopyFormFields />);
    expect(html).toContain('id="format"');
    expect(html).toContain('for="format"');
    expect(html).toContain('id="publisher"');
    expect(html).toContain('id="publishYear"');
    expect(html).toContain('id="specialNotes"');
  });

  it("prefixes every id/htmlFor pair when idPrefix is given, so two instances never collide", () => {
    const htmlA = renderToStaticMarkup(<CopyFormFields idPrefix="copy-a" />);
    const htmlB = renderToStaticMarkup(<CopyFormFields idPrefix="copy-b" />);

    for (const field of ["format", "publisher", "publishYear", "specialNotes"]) {
      expect(htmlA).toContain(`id="copy-a-${field}"`);
      expect(htmlA).toContain(`for="copy-a-${field}"`);
      expect(htmlB).toContain(`id="copy-b-${field}"`);
      // The two instances must not share a single id for the same field.
      expect(htmlA).not.toContain(`id="copy-b-${field}"`);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/CopyFormFields.test.tsx`

Expected: FAIL — `idPrefix` isn't a recognized prop yet, and the prefixed-id assertions don't match the current hardcoded ids.

- [ ] **Step 3: Add the idPrefix prop**

In `src/components/CopyFormFields.tsx`, replace the full file with:

```tsx
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
  // Distinguishes this instance's field ids from any other CopyFormFields
  // rendered on the same page (e.g. one section per physical copy on the
  // consolidated book edit page) -- without it, every instance would emit
  // the same id="format" etc., which is invalid HTML and breaks label
  // association for every instance after the first. Empty by default so
  // the single-instance callers (AddCopyForm) keep their existing ids
  // unchanged.
  idPrefix?: string;
}

export function CopyFormFields({
  defaultFormat = "",
  defaultPublisher = "",
  defaultPublishYear = "",
  defaultSpecialNotes = "",
  idPrefix = "",
}: CopyFormFieldsProps) {
  const fieldId = (name: string) => (idPrefix ? `${idPrefix}-${name}` : name);

  return (
    <>
      <div>
        <label htmlFor={fieldId("format")} className="block text-sm font-medium">
          Format
        </label>
        <select
          id={fieldId("format")}
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
        <label htmlFor={fieldId("publisher")} className="block text-sm font-medium">
          Publisher
        </label>
        <input
          id={fieldId("publisher")}
          name="publisher"
          defaultValue={defaultPublisher}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor={fieldId("publishYear")} className="block text-sm font-medium">
          Publish Year
        </label>
        <input
          id={fieldId("publishYear")}
          name="publishYear"
          type="number"
          defaultValue={defaultPublishYear}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
      <div>
        <label htmlFor={fieldId("specialNotes")} className="block text-sm font-medium">
          Special Notes
        </label>
        <textarea
          id={fieldId("specialNotes")}
          name="specialNotes"
          defaultValue={defaultSpecialNotes}
          className="mt-1 w-full rounded border p-2"
        />
      </div>
    </>
  );
}
```

Note: `name` attributes are deliberately NOT prefixed (only `id`/`htmlFor`) — the surrounding `<form>`'s `action` reads `formData.get("format")` etc. by the plain field name, and each physical copy's fields live in their own separate `<form>` (per the design's "independent sections, independent submits" decision), so there's no `FormData` collision to worry about, only a DOM-id collision.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/CopyFormFields.test.tsx`

Expected: both tests pass.

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`, `npx eslint src/components/CopyFormFields.tsx src/components/CopyFormFields.test.tsx`, `npm test`

Expected: all clean, all passing (the existing `AddCopyForm` caller passes no `idPrefix`, so its unprefixed rendering is unchanged — confirmed by this task's own first test).

- [ ] **Step 6: Commit**

```bash
git add src/components/CopyFormFields.tsx src/components/CopyFormFields.test.tsx
git commit -m "feat: add idPrefix to CopyFormFields for multi-instance pages

Prepares CopyFormFields to be rendered once per physical copy on the
upcoming consolidated book edit page without producing colliding DOM
ids. Defaults to unprefixed (current behavior) so the existing single-
instance caller (AddCopyForm) is unaffected."
```

## Task 2: Relocate the copy-edit form components and repoint their actions' redirects

**Files:**
- Move: `src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx` → `src/components/EditCopyForm.tsx`
- Move: `src/app/books/[id]/ebook-copies/[copyId]/edit/EditEbookCopyCoverForm.tsx` → `src/components/EditEbookCopyCoverForm.tsx`
- Move: `src/app/books/[id]/audiobook-copies/[copyId]/edit/EditAudiobookCopyCoverForm.tsx` → `src/components/EditAudiobookCopyCoverForm.tsx`
- Delete: `src/app/books/[id]/copies/[copyId]/edit/page.tsx` (and the now-empty `copies/[copyId]/edit/` directory)
- Delete: `src/app/books/[id]/ebook-copies/[copyId]/edit/page.tsx` (and the now-empty `ebook-copies/[copyId]/edit/` directory)
- Delete: `src/app/books/[id]/audiobook-copies/[copyId]/edit/page.tsx` (and the now-empty `audiobook-copies/[copyId]/edit/` directory)
- Modify: `src/lib/actions/copies.ts` (`updateCopy`)
- Modify: `src/lib/actions/books.ts` (`updateBook`)
- Modify: `src/lib/actions/ebookCopies.ts` (`updateEbookCopyCover`)
- Modify: `src/lib/actions/audiobookCopies.ts` (`updateAudiobookCopyCover`)

This task has no new tests of its own (no business logic changes — `updateCopyData`/`updateBookData`/etc. are untouched; only the wrapping actions' redirect target and the form components' file location change, neither of which this codebase has existing test coverage for at the action-wrapper level). Task 6 verifies this task's changes via a real browser walkthrough.

- [ ] **Step 1: Move the three form components to src/components/**

Move `src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx` to `src/components/EditCopyForm.tsx` with no content change except passing `idPrefix={copyId}` to `CopyFormFields` (this is the component Task 1 prepared for):

```tsx
"use client";

import { useActionState, useState } from "react";
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
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields
        idPrefix={copyId}
        defaultFormat={defaultFormat}
        defaultPublisher={defaultPublisher}
        defaultPublishYear={defaultPublishYear}
        defaultSpecialNotes={defaultSpecialNotes}
      />
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        allowCamera
        onBusyChange={setIsPreparingCover}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending || isPreparingCover}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : isPreparingCover ? "Preparing cover..." : "Save"}
      </button>
    </form>
  );
}
```

Move `src/app/books/[id]/ebook-copies/[copyId]/edit/EditEbookCopyCoverForm.tsx` to `src/components/EditEbookCopyCoverForm.tsx` with no content change at all (already has no page-relative imports):

```tsx
"use client";

import { useActionState, useState } from "react";
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
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        onBusyChange={setIsPreparingCover}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending || isPreparingCover}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : isPreparingCover ? "Preparing cover..." : "Save"}
      </button>
    </form>
  );
}
```

Move `src/app/books/[id]/audiobook-copies/[copyId]/edit/EditAudiobookCopyCoverForm.tsx` to `src/components/EditAudiobookCopyCoverForm.tsx`, same treatment (identical shape, just the audiobook equivalent):

```tsx
"use client";

import { useActionState, useState } from "react";
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
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        onBusyChange={setIsPreparingCover}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending || isPreparingCover}
        className="w-full rounded bg-black p-2 text-white disabled:opacity-50"
      >
        {isPending ? "Saving..." : isPreparingCover ? "Preparing cover..." : "Save"}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Delete the three old route files and their directories**

```bash
rm "src/app/books/[id]/copies/[copyId]/edit/page.tsx"
rm "src/app/books/[id]/copies/[copyId]/edit/EditCopyForm.tsx"
rmdir "src/app/books/[id]/copies/[copyId]/edit"

rm "src/app/books/[id]/ebook-copies/[copyId]/edit/page.tsx"
rm "src/app/books/[id]/ebook-copies/[copyId]/edit/EditEbookCopyCoverForm.tsx"
rmdir "src/app/books/[id]/ebook-copies/[copyId]/edit"
rmdir "src/app/books/[id]/ebook-copies/[copyId]"
rmdir "src/app/books/[id]/ebook-copies"

rm "src/app/books/[id]/audiobook-copies/[copyId]/edit/page.tsx"
rm "src/app/books/[id]/audiobook-copies/[copyId]/edit/EditAudiobookCopyCoverForm.tsx"
rmdir "src/app/books/[id]/audiobook-copies/[copyId]/edit"
rmdir "src/app/books/[id]/audiobook-copies/[copyId]"
rmdir "src/app/books/[id]/audiobook-copies"
```

(All paths are double-quoted deliberately — `[id]`/`[copyId]` are literal Next.js dynamic-route directory names here, but bash also treats unquoted `[...]` as a glob character class; quoting avoids depending on bash's unmatched-glob-passes-through-literally fallback behavior. `copies/[copyId]/` itself stays — the sibling `copies/new/` route under it is unaffected and unrelated to this deletion. `rmdir` only removes a directory if it's already empty; if any of these fail because a directory still has files in it, stop and check what's still there rather than force-deleting.)

- [ ] **Step 3: Update the four action files' redirect targets**

In `src/lib/actions/copies.ts`, in `updateCopy`, change:

```ts
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
```

to:

```ts
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}/edit`);
```

(This is the second `revalidatePath`/`redirect` pair in the file, inside `updateCopy` — do NOT change `addCopy`'s or `deleteCopy`'s redirect targets, both stay pointed at `/books/${bookId}` per the design's non-goals.)

In `src/lib/actions/books.ts`, in `updateBook`, change:

```ts
  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
```

to:

```ts
  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}/edit`);
```

(Do NOT change `createBookWithCopy`'s or `createBookFromScan`'s redirect targets — both are the "new book" flow, unrelated to this plan.)

In `src/lib/actions/ebookCopies.ts`, in `updateEbookCopyCover`, change:

```ts
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
```

to:

```ts
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}/edit`);
```

In `src/lib/actions/audiobookCopies.ts`, in `updateAudiobookCopyCover`, change:

```ts
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
```

to:

```ts
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}/edit`);
```

- [ ] **Step 4: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`

Expected: this WILL fail at this point — the current `src/app/books/[id]/edit/page.tsx` and `src/app/books/[id]/page.tsx` don't yet import the moved components or reflect the new routes, but nothing in THIS task's own changed files should cause new errors. If `tsc` reports errors specifically about the files this task touched (the four action files, the three moved components), fix them. Errors about `src/app/books/[id]/edit/page.tsx` or `src/app/books/[id]/page.tsx` are expected and will be resolved by Tasks 3 and 4 — do not attempt to fix those files in this task.

Run: `npx eslint src/lib/actions/copies.ts src/lib/actions/books.ts src/lib/actions/ebookCopies.ts src/lib/actions/audiobookCopies.ts src/components/EditCopyForm.tsx src/components/EditEbookCopyCoverForm.tsx src/components/EditAudiobookCopyCoverForm.tsx`

Expected: clean.

Run: `npm test`

Expected: all passing (no test in this codebase exercises the deleted routes or the changed redirect targets directly, per this task's own note above — this is confirming nothing UNRELATED broke, not confirming this task's own behavior, which Task 6 verifies in a real browser).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move copy-edit forms to src/components/, remove standalone routes

EditCopyForm/EditEbookCopyCoverForm/EditAudiobookCopyCoverForm move out
of their route-local directories so they can be rendered inline on the
consolidated book edit page (next task) instead of on their own
routes. The three now-redundant standalone routes
(/books/[id]/copies/[copyId]/edit and the ebook/audiobook cover
equivalents) are deleted. updateCopy/updateBook/updateEbookCopyCover/
updateAudiobookCopyCover now redirect to /books/[id]/edit instead of
the book detail page, so saving any section keeps the user on the
consolidated edit page instead of bouncing them away from it.

This intentionally leaves /books/[id]/edit/page.tsx and
/books/[id]/page.tsx not yet updated to use the moved components --
the next two tasks complete that. tsc will show expected errors in
those two files until then."
```

## Task 3: Rewrite the consolidated edit page

**Files:**
- Modify: `src/app/books/[id]/edit/page.tsx`

- [ ] **Step 1: Rewrite the page**

Replace `src/app/books/[id]/edit/page.tsx` in full:

```tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditBookForm } from "./EditBookForm";
import { EditCopyForm } from "@/components/EditCopyForm";
import { EditEbookCopyCoverForm } from "@/components/EditEbookCopyCoverForm";
import { EditAudiobookCopyCoverForm } from "@/components/EditAudiobookCopyCoverForm";
import {
  updateReadStatus,
  updateRating,
  clearReadStatusManual,
  clearRatingManual,
} from "@/lib/actions/readingProgress";
import { READ_STATUS_OPTIONS, RATING_OPTIONS } from "@/components/ReadingProgressFields";

export default async function EditBookPage({
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
    <main className="mx-auto max-w-lg space-y-8 p-4">
      <div>
        <h1 className="mb-4 text-2xl font-semibold">Edit Book</h1>
        <EditBookForm
          bookId={book.id}
          defaultTitle={book.title}
          defaultAuthor={book.author ?? ""}
          defaultIsbn={book.isbn ?? ""}
        />
      </div>

      <div className="space-y-2 rounded border p-3">
        <h2 className="text-lg font-medium">Reading Progress</h2>
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

      {book.copies.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-medium">Physical Copies</h2>
          <div className="space-y-6">
            {book.copies.map((copy, index) => (
              <div key={copy.id} className="rounded border p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">
                  Physical Copy #{index + 1}
                </h3>
                <EditCopyForm
                  copyId={copy.id}
                  bookId={book.id}
                  defaultFormat={copy.format}
                  defaultPublisher={copy.publisher ?? ""}
                  defaultPublishYear={copy.publishYear?.toString() ?? ""}
                  defaultSpecialNotes={copy.specialNotes ?? ""}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {book.ebookCopies.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-medium">Ebooks</h2>
          <div className="space-y-6">
            {book.ebookCopies.map((copy, index) => (
              <div key={copy.id} className="rounded border p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">
                  Ebook #{index + 1}
                </h3>
                <EditEbookCopyCoverForm
                  copyId={copy.id}
                  bookId={book.id}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {book.audiobookCopies.length > 0 && (
        <div>
          <h2 className="mb-2 text-lg font-medium">Audiobooks</h2>
          <div className="space-y-6">
            {book.audiobookCopies.map((copy, index) => (
              <div key={copy.id} className="rounded border p-3">
                <h3 className="mb-2 text-sm font-semibold text-gray-700">
                  Audiobook #{index + 1}
                </h3>
                <EditAudiobookCopyCoverForm
                  copyId={copy.id}
                  bookId={book.id}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Typecheck and lint this file**

Run: `npx tsc --noEmit` — expected: no NEW errors from this file (errors about `src/app/books/[id]/page.tsx`, if any remain from Task 2, are expected until Task 4).

Run: `npx eslint src/app/books/[id]/edit/page.tsx` — expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/books/[id]/edit/page.tsx
git commit -m "feat: consolidate all book editing onto /books/[id]/edit

Adds Reading Progress (moved from the book detail page), and one
inline section per physical/ebook/audiobook copy (moved from their
now-deleted standalone routes) to the existing title/author/isbn edit
page. Each section keeps its own independent form/action, reusing
EditCopyForm/EditEbookCopyCoverForm/EditAudiobookCopyCoverForm moved
in the prior task."
```

## Task 4: Update the book detail page

**Files:**
- Modify: `src/app/books/[id]/page.tsx`

- [ ] **Step 1: Remove the Reading Progress section and repoint copy links**

Replace `src/app/books/[id]/page.tsx` in full:

```tsx
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
              <Link href={`/books/${book.id}/edit`} className="text-sm underline">
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
                <Link href={`/books/${book.id}/edit`} className="mt-2 inline-block text-sm underline">
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
                <Link href={`/books/${book.id}/edit`} className="mt-2 inline-block text-sm underline">
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

Changes from the current file: the entire "Reading Progress" `<div>` block (readStatus/rating forms and their clear-manual-override buttons) is removed; the now-unused `updateReadStatus`/`updateRating`/`clearReadStatusManual`/`clearRatingManual`/`READ_STATUS_OPTIONS`/`RATING_OPTIONS` imports are removed; the physical copy "Edit" link and both "Edit cover" links now point to `/books/${book.id}/edit` instead of their old per-copy routes.

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit` — expected: clean now (this was the last file with expected-until-now errors from Task 2).

Run: `npx eslint src/app/books/[id]/page.tsx` — expected: clean.

- [ ] **Step 3: Run the full suite**

Run: `npm test` — expected: all passing.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/[id]/page.tsx
git commit -m "refactor: move Reading Progress off the book detail page, repoint copy edit links

Reading Progress now lives on /books/[id]/edit (previous task). The
detail page keeps browsing/deleting copies, but every 'Edit'/'Edit
cover' link now points at the consolidated edit page instead of the
now-deleted standalone per-copy routes."
```

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `npx tsc --noEmit`, `npx eslint .`, `npm test`

Expected: all clean, all passing.

- [ ] **Step 2: Manual browser verification**

This app has no automated Next.js page-rendering tests, so this step is the real verification for Tasks 2-4's page-composition changes — per this project's standing practice for UI changes, actually use the feature in a browser rather than only trusting the type-checker.

Start the dev server (`npm run dev`) against this worktree, then use Playwright (or the Playwright MCP tool) to:

1. Find (or create, via the existing `/books/[id]/copies/new` flow) a book that has: at least two physical copies, at least one ebook copy, and at least one audiobook copy — if the seeded dev data doesn't already have one, add a second physical copy to any existing multi-format book to get this shape.
2. Navigate to that book's `/books/[id]/edit` page. Confirm: title/author/isbn section, Reading Progress section, a "Physical Copy #1"/"Physical Copy #2" section each with independently correct default values (not each other's), an "Ebook #1" section, an "Audiobook #1" section.
3. Change one physical copy's publisher and save. Confirm the page reflects the change afterward (via the `redirect(`/books/${bookId}/edit`)` this plan set up) and that the OTHER physical copy's fields are untouched.
4. Set a manual reading status/rating override, confirm the "Let Goodreads manage this again" links appear and work.
5. Navigate to the book's detail page (`/books/[id]`). Confirm: no Reading Progress section there anymore; the physical copy's "Edit" link and the ebook/audiobook "Edit cover" links all lead to `/books/[id]/edit`; the "Delete" button for a copy still works (exercise it on a throwaway test copy, not real data).
6. Directly navigate the browser to one of the three deleted routes (e.g. `/books/[id]/copies/<a-real-copy-id>/edit`) and confirm it 404s rather than rendering a broken page.
7. Take a screenshot of the consolidated edit page for the record.

If anything in this walkthrough reveals a bug, fix it (with a matching automated test if the bug is at the data/action layer, e.g. in `updateCopyData`/an action's redirect target — not by adding new page-rendering test infrastructure, which is out of scope for this plan) before considering this task done.

- [ ] **Step 3: Report**

Confirm all steps above passed. This is the last task in the plan.

## Non-goals (do not implement)

- Adding a new physical copy (`/books/[id]/copies/new`) — stays exactly where it is.
- Deleting a copy or deleting a book — stays exactly where it is today.
- Any new server action — every field this plan touches already has a working update action.
- Making `hasEbook`/`hasAudiobook`/`lastAbsSyncedAt` user-editable — these stay sync-managed.
- A unified single-submit form — each section keeps saving independently.
- New automated page-rendering test infrastructure (jsdom/React Testing Library) — this codebase has never used it; Task 5's manual browser walkthrough is the verification method for the page-composition changes instead.
