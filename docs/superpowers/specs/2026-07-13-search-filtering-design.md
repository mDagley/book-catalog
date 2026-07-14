# Search & Browse Filtering — Design Spec

Date: 2026-07-13

## Purpose

Add filtering to the two existing browse/search surfaces — the home page's
unified search (`src/app/page.tsx`) and the physical-catalog browse page
(`src/app/books/page.tsx`) — so the user can narrow results by ownership
type (physical/ebook/audiobook) and physical format, without typing a text
query. This is the "Filtering (e.g. by format, owned status)" item from the
original design spec's "Deferred / Future Ideas" section
(`docs/superpowers/specs/2026-07-05-book-catalog-design.md`).

## Scope

Both pages get filtering:

- **Home page (`/`)**: ownership-type filter (physical / ebook / audiobook)
  plus a physical-format sub-filter.
- **`/books` (physical catalog browse)**: physical-format filter only (every
  row on this page is already a physically-owned book, so an ownership-type
  filter doesn't apply here).

## URL Scheme & Filter Semantics

**Home page (`/`) query params:**

- `q` — existing text query. Now optional (previously required to see any
  results at all).
- `types` — comma-separated list of ownership types to include:
  `physical`, `ebook`, `audiobook` (e.g. `?types=ebook,audiobook`). Omitted
  or empty means "all types" (today's unfiltered behavior).
- `format` — a physical `Format` enum value (`HARDCOVER`, `PAPERBACK`,
  `MASS_MARKET`, `OTHER`). Only meaningful when `physical` is among the
  selected types (or `types` is unset, meaning all types are included).

**`/books` query params:**

- `q` — existing text query, unchanged.
- `format` — same `Format` enum value as above.

**Combining rule (home page):** a book matches if it satisfies *any*
selected ownership type — e.g. `types=ebook,physical&format=PAPERBACK`
shows a book if it has an ebook, **or** has a paperback copy specifically
(not just any physical copy). If no `format` is set, any physical copy
counts toward the `physical` type.

**Format narrows both inclusion and display:** when a `format` filter is
active, only copies matching that format are included in a result's
displayed `physicalCopies` list — filtering to "Paperback" doesn't also
surface an unrelated hardcover copy on the same book. This applies
consistently on both pages; on `/books` the practical effect is just on
which books qualify, since that page only shows a copy *count*, not a
per-copy breakdown.

**Standalone browse mode:** the home page's `searchCatalog` currently
returns `[]` immediately whenever the query is empty. This changes to:
return `[]` only when there is no query text **and** no `types`/`format`
filter active. So `?types=ebook` alone (no `q`) becomes a valid "show me
everything I own as an ebook" browse view. The `/books` page already shows
the full catalog with no query (existing behavior, unaffected) — adding a
`format` filter there works the same way regardless of whether `q` is set.

## Home Page Implementation

**`src/lib/search.ts` — `searchCatalog` restructuring:**

The function's signature changes from a single `query: string` parameter to
an options object: `searchCatalog({ query, types, format })`, where:

- `query?: string` — same as today, optional now.
- `types?: ("physical" | "ebook" | "audiobook")[]` — undefined means all
  types included.
- `format?: Format` — undefined means no format restriction.

Query construction:

- If `types` is defined and excludes `"physical"`, skip the
  `prisma.book.findMany` call entirely (no physical results at all).
- The `copies: { some: {} }` existence guard exists in case a `Book` row
  ever ends up with zero `PhysicalCopy` rows — worth defending against even
  though it isn't reachable through the app's own UI today: `deleteCopyData`
  (`src/lib/copies.ts`) actually cascades to delete the parent `Book` once
  its last copy is removed (confirmed live during capstone verification),
  so this guard is a defensive measure, not a fix for an observed real
  scenario. It only applies when the user has **explicitly** asked for a
  physical-ownership view — i.e. `types` is defined and includes
  `"physical"`, or `format` is set. It does NOT apply to a fully
  unfiltered/default search (`types` and `format` both undefined) — there,
  a copyless book should still surface bare (empty `physicalCopies`, no
  physical badge), exactly as it did before this feature existed. The
  distinction matters: "no filter" isn't the same claim as "explicitly
  filtered to physical," and only the latter is strong enough that a
  copyless book must not be reported as satisfying it. If `format` is
  set, the guard narrows further to `copies: { some: { format } }`.
- The existing text-query `OR` clause (title/author/isbn `contains`) is
  only added to the `where` when `query` is non-empty; it's no longer
  unconditional.
- Similarly, if `types` is defined and excludes `"ebook"`, skip fetching
  `AbsCacheItem` rows with `mediaType: "EBOOK"`; same for `"audiobook"`.
  When both are excluded, skip the `AbsCacheItem` query entirely.
- The existing fuzzy-match merge logic (best-scoring title match, from the
  Phase 4 fix) is unchanged — it operates on whatever filtered subsets come
  back from the two queries above.
- When constructing each result's displayed `physicalCopies` list, only
  include copies matching `format` if a format filter is active; otherwise
  include all of that book's copies (today's behavior).
- Return `[]` immediately only when `query` is empty/whitespace AND `types`
  is unset AND `format` is unset (nothing to search or filter on — this
  matches today's "blank placeholder search page" state).

**Invalid input handling:** an unrecognized `format` value (doesn't match
the `Format` enum) is ignored, treated as unset. Unrecognized tokens inside
`types` are dropped; if every token is unrecognized, `types` is treated as
unset (show all types) rather than showing nothing. An empty `types=`
param is likewise treated as unset.

**UI (`src/app/page.tsx`):** the existing plain `<form method="get">` gains
three checkboxes (Physical / Ebook / Audiobook, mapped to the `types`
param) and a format `<select>` (reusing the existing `FORMAT_LABELS` map
from `src/components/CopyFormFields.tsx`), submitted together with the
existing text input. No client-side JavaScript — this is a full page
navigation on submit, consistent with how the search box and `/books` page
already work.

## `/books` Page Implementation

Simpler than the home page — no ownership-type filter needed.

- Add a `format` `<select>` to the existing GET form (same `FORMAT_LABELS`
  options as the home page).
- When set, add `copies: { some: { format } }` to the existing
  `prisma.book.findMany` call's `where` clause, combined (via implicit
  `AND`) with the existing title/author/isbn `OR` clause when a text query
  is also present.
- The page continues to show only a copy **count** per book (no per-copy
  breakdown — that's on the book detail page), so there's no "hide
  non-matching copies" display concern here; the format filter only
  controls which books appear in the list, not what's shown about them.
- An invalid `format` value is ignored the same way as on the home page.

## Testing

- **`src/lib/search.ts`** (already covered by `search.test.ts`): add cases
  for — `types` excluding a media type actually excludes it from results;
  `format` narrows both book-inclusion and the displayed `physicalCopies`
  list; standalone browse (no `query`, `types`/`format` set) returns
  results; a zero-copy `Book` row is excluded from the `"physical"` type
  even with no `format` set; unrecognized `format`/`types` values are
  ignored rather than erroring; combining `query` with `types`/`format`
  narrows correctly.
- **`/books` page**: no dedicated test file — consistent with this
  codebase's existing convention that only `src/lib/*.ts` business logic
  gets unit tests, not page/route files. The format-filter addition here is
  a single conditional on an already-inline Prisma query; verified live
  instead.
- **Live verification** (required before considering this done, matching
  every prior phase's capstone pattern): filter the home page to
  ebook-only and confirm only ebook-owned titles appear; filter `/books` by
  a specific format and confirm the right subset appears; confirm
  standalone browse (filters only, no text) works on the home page; delete
  a book's only copy and confirm it no longer appears under the physical
  filter.

## Non-Goals

- No new filter dimensions beyond ownership type and physical format (no
  publisher/year/publish-date filtering, no series filtering — series
  tracking is a separate, unplanned backlog item).
- No client-side/instant filtering — this stays a server-rendered,
  URL-driven, full-navigation pattern consistent with the rest of the app.
- No changes to the TBR gap view (`/tbr`) — it isn't a search/browse
  surface in the same sense (no text query, no ownership-type ambiguity
  since everything on it is by definition not-yet-owned) and wasn't part
  of the "Filtering" backlog item.
