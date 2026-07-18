# Copy Cover Images (Ebook/Audiobook Upload + Cross-Type Editing) — Design

## Purpose

Two related backlog gaps, addressed together:

1. **Ebook/audiobook covers don't exist at all.** `EbookCopy`/`AudiobookCopy` gained a `coverImagePath` column in the `unify-copy-types` migration specifically to enable this, but nothing sets or reads it yet. These copies also have zero UI presence — the book detail page only lists `PhysicalCopy` rows; ebook/audiobook ownership shows only as a `hasEbook`/`hasAudiobook` boolean badge elsewhere.
2. **Physical copy covers can only be set once, at creation time**, via the scan flow's camera-capture-or-Open-Library picker. There's no way to add a cover after the fact, or replace one that's wrong.

This phase closes both: ebook/audiobook copies become visible and cover-editable, and physical copies gain the same post-creation cover-editing capability.

## Scope

**In scope:**
- List `EbookCopy`/`AudiobookCopy` rows on the book detail page (new "Ebooks"/"Audiobooks" sections, alongside the existing "Copies" physical section).
- A cover-editing page per ebook/audiobook copy (file upload or Open Library lookup by the parent Book's ISBN).
- A cover-editing section added to the existing physical copy edit page (file upload, Open Library lookup, or camera capture).
- Shared cover-resolution logic so "given a new cover input and the copy's current cover, save the new one and clean up the old one" isn't implemented three times.

**Out of scope (see other backlog items):**
- Cover thumbnails in the home page search results or `/books` listing.
- Filters on `/books`/`/tbr`.
- A more robust cover-capture tool (crop-to-cover, flash toggle, video-frame-picking).
- Deleting an ebook/audiobook copy itself (unchanged — still owned by the ABS sync's lifecycle, not manually removable).
- Any change to `EbookCopy`/`AudiobookCopy`/`PhysicalCopy` schema — `coverImagePath` already exists on all three from `unify-copy-types`.

## Architecture

Three copy types (`PhysicalCopy`, `EbookCopy`, `AudiobookCopy`) each get their own explicit route, page, and thin server action — matching this codebase's existing convention of treating the three copy types as distinct throughout (e.g. `absSync.ts` never collapses ebook/audiobook into one generic code path). What *is* shared:

- **`<CoverEditor>`** (new client component) — the actual cover-picking UI (file upload, Open Library lookup, optional camera capture), reused across all three edit contexts.
- **A shared server-side cover-resolution helper** (new) — given new cover input (a data URL or a remote URL) and the copy's current `coverImagePath`, saves the new file and deletes the old one if replaced. Called from three thin, separate update functions, one per copy type.

This avoids tripling the actual file-handling logic while keeping each copy type's route/action explicit and independently readable — no new "generic copy" abstraction layer is introduced.

## Data Flow

### `<CoverEditor>` component

Props: `currentCoverPath: string | null`, `bookIsbn: string | null`, `allowCamera: boolean`.

Renders:
- Current cover thumbnail (via the existing `/api/covers/[filename]` route) or a "No cover set" placeholder.
- A plain `<input type="file" accept="image/*">`. On selection, reads the file into a data URL client-side via `FileReader` (no new upload endpoint — this feeds the same hidden-field pattern `CoverPicker` already uses).
- An "Open Library" button (disabled/hidden if `bookIsbn` is null) — calls the existing `lookupIsbn(bookIsbn)` (`src/lib/isbnLookup.ts`, unchanged) client-side via a small wrapper server action, previews the returned `coverUrl` if present.
- If `allowCamera`, the existing `CoverCamera` component, wired the same way the scan flow already does.
- Whichever candidate is selected populates the same two hidden form fields `CoverPicker` already establishes (`selectedCoverDataUrl`, `selectedCoverSource`), so the surrounding `<form>`'s submit handling doesn't need new shape — this is a superset/generalization of `CoverPicker`, not a parallel reimplementation. (If reuse turns out cleaner than a new component once in code, `CoverPicker` may be extended in place instead of creating a sibling — implementation detail to confirm during the plan, not a design commitment either way.)

### Shared cover-resolution helper

New function (in `src/lib/coverStorage.ts`, alongside `saveCoverImage`/`deleteCoverImage`, or a new small sibling module if that file would grow unwieldy — implementation detail for the plan):

```
resolveCoverUpdate(
  input: { dataUrl?: string; coverUrl?: string },
  currentCoverImagePath: string | null,
): Promise<{ coverImagePath: string | null }>
```

- If neither `dataUrl` nor `coverUrl` is provided, returns `{ coverImagePath: currentCoverImagePath }` (no-op).
- If `dataUrl` is provided, calls `saveCoverImage(dataUrl)` (existing, unchanged).
- If `coverUrl` is provided, calls `saveCoverFromUrl(coverUrl)` (existing, unchanged) and propagates its `{ error }` shape if it fails.
- In either save case, if `currentCoverImagePath` was set and differs from the new one, calls `deleteCoverImage(currentCoverImagePath)` (existing, unchanged) to clean up the replaced file.

### Per-copy-type update actions

- **`updateCopy`** (`src/lib/actions/copies.ts`, existing — extended): the existing form gains the cover fields; `updateCopyData` (`src/lib/copies.ts`) calls the shared helper before its `physicalCopy.update`.
- **`updateEbookCopyCover`** (new, `src/lib/actions/ebookCopies.ts` or added to a new `src/lib/ebookCopies.ts` — implementation detail for the plan): resolves the cover, then `prisma.ebookCopy.update({ where: { id }, data: { coverImagePath } })`.
- **`updateAudiobookCopyCover`** (new, mirrors the ebook one exactly for `AudiobookCopy`).

## Routes & Pages

- **`src/app/books/[id]/ebook-copies/[copyId]/edit/page.tsx`** (new) — fetches the `EbookCopy` (404 if missing or `bookId` mismatch) and its parent `Book`'s `isbn`, renders a form with just `<CoverEditor allowCamera={false}>`, submits to `updateEbookCopyCover`, redirects to `/books/[id]` on success.
- **`src/app/books/[id]/audiobook-copies/[copyId]/edit/page.tsx`** (new) — identical shape for `AudiobookCopy`.
- **`src/app/books/[id]/copies/[copyId]/edit/page.tsx`** (existing, physical) — gains a `<CoverEditor allowCamera={true}>` section alongside the existing format/publisher/publishYear/specialNotes fields, still one form/one submit.

## Book Detail Page Changes

`src/app/books/[id]/page.tsx`'s query gains `ebookCopies: true, audiobookCopies: true` in its `include` (ordered by `createdAt asc`, matching the existing `copies` ordering). Two new list sections render below the existing "Copies" section:

- **"Ebooks"** — one row per `EbookCopy`: cover thumbnail (or placeholder) + "Edit cover" link to its new edit page. No delete button (see Non-goals).
- **"Audiobooks"** — identical shape for `AudiobookCopy`.

Sections are omitted entirely (not shown empty) when the book has zero copies of that type — matching how the existing physical "Copies" section already always has at least one row in practice, so there's no existing empty-state precedent to match, but hiding an empty section is the least visually noisy choice.

## Testing

- **Shared cover-resolution helper**: unit tests mocking `saveCoverImage`/`saveCoverFromUrl`/`deleteCoverImage` — covers first-time set (no old file to delete), replace (old file deleted), no-op (neither input provided).
- **Three update actions/lib functions**: thin tests matching the existing `copies.test.ts` style — verify the right Prisma model gets updated, verify a `saveCoverFromUrl` error surfaces as `{ error }` without touching the DB.
- **`<CoverEditor>` and the new/updated pages**: not unit-tested (no component-testing framework in this project) — verified manually in a real browser (Playwright, following the same session-cookie-minting technique used for the `RefreshSyncButton` fix) before considering the phase done.

## Non-Goals

(Repeated from Scope for clarity — see above.) Cover thumbnails in listings, `/books`/`/tbr` filters, a more robust capture tool, and ebook/audiobook copy deletion are all explicitly out of scope.
