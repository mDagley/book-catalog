# Manage All Books — Design

## Overview

`/books` is currently "Manage Physical Books": it queries only `Book` rows with physical copies, using its own hand-built Prisma query separate from the home page's unified `searchCatalog`. This phase reframes it into a dedicated browse/manage page for the *entire* catalog (physical + ebook + audiobook), reusing the home page's already-built unified search infrastructure instead of maintaining a parallel physical-only implementation.

The home page stays exactly as it is today — a quick "do I already own this?" search that shows nothing until you type a query or pick a filter. `/books` becomes the full browsable catalog: shows everything by default, with the same ownership-type/format/status filters home already has, plus the management-oriented actions (`+ Add a book`, `Check for duplicate books`) that don't belong on a quick-search page.

This also resolves backlog item #7 (a Book with only digital ownership and zero physical copies showing up on a page titled "Physical Books") by construction — the page's scope becomes legitimately "all books," so there's no longer a mismatch between title and contents.

## Data layer: extend `searchCatalog`, don't duplicate it

`searchCatalog` (`src/lib/search.ts`) already has everything `/books` needs — ownership-type filtering, format filtering, status/rating filtering, ISBN-aware text search — except two behaviors specific to a browse page:

1. **Empty-by-default.** Before this change, `searchCatalog` returns `[]` immediately when no query/types/format/status are active (`if (!trimmed && !types && !format && !statusValues) return [];`) — correct for home's search-first framing, wrong for a browse page that should show everything with no filters applied.
2. **Sort order.** Before this change, results are ordered `id: asc` (creation order) — fine for a filtered/searched result set, not useful for browsing potentially hundreds of unfiltered books.

Rather than giving `/books` its own separate copy of the ownership/format/status-filter query logic (real duplication risk — this exact kind of drift already happened once between `/books`' old physical-only query and `searchCatalog`, which is part of why item #7 existed), extend `searchCatalog` with two new, backward-compatible options:

- `browseAll?: boolean` (default `false`) — when `true`, skips the empty-by-default early return, so a call with no filters returns every book. Home never passes this, so its existing behavior is untouched.
- `sortBy?: "id" | "title"` (default `"id"`, preserving home's current behavior) — `/books` passes `"title"` for alphabetical browsing.

`/books/page.tsx` calls `searchCatalog({ query, types, format, status, statusMode, browseAll: true, sortBy: "title" })` instead of building its own Prisma query. This also means `/books` automatically gets ISBN-aware search (an existing gap — backlog item #14 — evaporates for the `/books` scope specifically; `home`'s own autocomplete-route ISBN gap is separate and out of scope here).

## Filter UI: reuse home's exact filter row

`/books` gets the same filter row already built for home: ownership-type checkboxes (Physical/Ebook/Audiobook), status checkboxes with Any/All match mode, and the format `<select>`. This is already close to a copy-paste today (both pages already share `buildStatusWhere`, `FORMAT_OPTIONS`, `STATUS_FILTER_OPTIONS`) — this phase finishes that consolidation by also sharing `OWNERSHIP_TYPE_OPTIONS` and the filter-row JSX shape. If the filter row's JSX is identical enough between the two pages after this change, extracting a shared `<CatalogFilters>` component is a reasonable in-scope cleanup (follows the "improve code you're touching" principle) rather than copy-pasting the block a second time.

## Listing: reuse home's result-card shape

Each book renders exactly like a home search result does today: cover thumbnail, title, author, then badges per ownership type (`Physical (Hardcover)`, `Ebook ✓`, `Audiobook ✓`, read status, rating stars), linking to `/books/[id]`. This replaces `/books`' current simpler "N copies" text-only display. Since `searchCatalog`'s `SearchResult` shape already carries everything needed for these badges, `/books` renders the same JSX block home uses — worth extracting into a shared `<CatalogResultCard>` component during implementation, since it'll otherwise be a second copy-paste of a fairly detailed block.

## Page framing

- Heading changes from "Physical Books" to **"All Books"**.
- `+ Add a book` (links to `/books/scan`, the physical barcode-scan flow) and `Check for duplicate books` (`/books/duplicates`) stay exactly as they are — both remain relevant regardless of the page now showing all ownership types, since physical scan-add is still the only manual-add path in the app.
- Route stays `/books` — no URL change.
- Home page's own "Manage physical books" link text (`src/app/page.tsx`) updates to "Manage all books" / similar, matching the new scope.

## Non-goals

- No changes to the home page's own search behavior, framing, or default empty state.
- No changes to `/books/[id]` (book detail page) or any copy-management/edit flows.
- No bulk actions (multi-select, bulk edit/delete) — out of scope, not requested.
- No changes to how ebook/audiobook copies get added (still exclusively via ABS/Goodreads sync).
- Does not fix backlog item #14's `home`/`books` *autocomplete route* ISBN gap (a separate route, `src/app/api/autocomplete/route.ts`) — only the `/books` page's own direct search query gains ISBN-awareness via `searchCatalog`, which it already had before this phase in a different form.

## Testing

- `searchCatalog`'s new `browseAll`/`sortBy` options get direct integration tests in the existing `src/lib/search.test.ts` (already has 48 tests covering `searchCatalog`'s current behavior) — covering: `browseAll: true` with no filters returns all books; `browseAll: false` (or omitted) preserves the existing empty-by-default behavior for home; `sortBy: "title"` sorts alphabetically; `sortBy` omitted preserves `id asc`.
- `/books/page.tsx`'s integration is covered indirectly through `searchCatalog`'s own tests plus manual verification (this app's established convention — no direct page-rendering tests exist anywhere in the codebase today).
