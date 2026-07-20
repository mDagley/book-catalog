# Consolidated Book Edit Page — Design

## Overview

Backlog item #19: editing a book's data is currently fragmented across several pages —

- `/books/[id]/edit` (`EditBookForm`/`BookFormFields`): title, author, isbn.
- `/books/[id]` (the detail page): `readStatus`/`rating`, each with its own form and a "Manually set" / clear-override button when `readStatusManual`/`ratingManual` is true.
- `/books/[id]/copies/[copyId]/edit` (`EditCopyForm`/`CopyFormFields` + `CoverEditor`), one page per physical copy: format, publisher, publishYear, specialNotes, cover.
- `/books/[id]/ebook-copies/[copyId]/edit` and `/books/[id]/audiobook-copies/[copyId]/edit`, one page per ebook/audiobook copy: cover only (these copy types have no other user-editable field — `absItemId` is a sync key, not editable).

This phase consolidates all of it onto `/books/[id]/edit`, so there's exactly one page to edit anything about a book.

## Design

**Structure:** independent sections on one page, each keeping its own existing form and server action — no new unified "save everything" action, no new server actions at all. This is page composition of components that already exist and already work; the only genuinely new code is what's needed to render an arbitrary number of copies inline instead of on their own routes.

- **Book fields** section: `EditBookForm`/`BookFormFields` unchanged (title, author, isbn).
- **Read status / rating** section: the existing forms and `clearReadStatusManual`/`clearRatingManual` actions currently on `/books/[id]/page.tsx` move to the edit page as their own section. Logic unchanged, only relocated.
- **Physical copies** section: one inline sub-section per existing `PhysicalCopy`, each reusing `CopyFormFields` + `CoverEditor` + the existing `updateCopy` action. `CopyFormFields` currently hardcodes `id="format"`, `id="publisher"`, `id="publishYear"`, `id="specialNotes"` — safe for a single copy per page, but would produce duplicate DOM ids (invalid HTML, broken `htmlFor` label association) once more than one copy's fields render on the same page. `CopyFormFields` gains an `idPrefix` prop (e.g. `copy-${copyId}-format`), threaded through every `id`/`htmlFor` pair in the component; `EditCopyForm`'s own usage (still the one place this component is called from, now embedded rather than on its own route) passes the copy's id as the prefix.
- **Ebook / audiobook copies** sections: one inline sub-section per existing copy, reusing `CoverEditor` + the existing update-cover actions (`EditEbookCopyCoverForm`/`EditAudiobookCopyCoverForm`'s current logic, embedded rather than on their own routes). `CoverEditor` itself has no hardcoded ids today (verified by reading the component) — safe to render multiple times per page as-is.

**Removed:** the three standalone routes once their content is embedded — `/books/[id]/copies/[copyId]/edit`, `/books/[id]/ebook-copies/[copyId]/edit`, `/books/[id]/audiobook-copies/[copyId]/edit` (and their page/form files). Any existing link to one of these (e.g. from the book detail page's copy listing) becomes a plain link to `/books/[id]/edit` — no per-section deep-linking (e.g. `#copy-<id>` anchors) is required by this phase.

## Non-goals

- Adding a new physical copy (`/books/[id]/copies/new`) stays exactly where it is — this is a create flow, not field-editing.
- Deleting a copy or deleting a book stays exactly where it is today (currently on the detail page) — not part of this ask.
- No new server actions — every field this phase touches already has a working update action; this phase only changes where the corresponding form is rendered.
- No change to `hasEbook`/`hasAudiobook`/`lastAbsSyncedAt` — these are sync-managed, not user-editable, and stay that way.
- No unified single-submit form. Each section keeps saving independently, matching how the app already behaves today (e.g. saving the format doesn't require also touching the cover).

## Testing

- Component/integration tests for the consolidated edit page confirming: title/author/isbn submit via the existing `updateBook` action; readStatus/rating submit and the manual-override clear buttons work identically to their current detail-page behavior; each physical copy's fields submit independently via `updateCopy` without affecting other copies' sections; multiple physical copies render with distinct, non-colliding DOM ids (a real `<label>`/`<input>` pairing check, not just a visual check).
- A regression check that the three removed routes actually return 404 (or are gone from the router) rather than silently left as orphaned, unlinked-but-still-functional pages.
