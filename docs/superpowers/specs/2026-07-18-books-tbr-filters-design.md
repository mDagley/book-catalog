# Filters on /books and /tbr — Design

## Overview

The home page's unified search already has a full filter UI: ownership type (physical/ebook/audiobook), physical format, and read-status/rating (To Read / Reading / Read / Unrated, with an Any/All match mode). Two other list views never got the equivalent treatment:

- `/books` (Manage Physical Books) has a format filter but no status/rating filter.
- `/tbr` (TBR gap view) has no search or filter UI of any kind.

This phase brings both pages up to parity with what makes sense for their scope — `/books` gains the missing status/rating filter, and `/tbr` gains a search box plus an alphabetical jump list (TBR items carry no format/status/rating data at all, so a literal port of the home page's filters doesn't apply there).

## /books filters

Add a status/rating filter row identical in behavior to the home page's: checkboxes for `STATUS_FILTER_OPTIONS` (`to_read`, `reading`, `read`, `unrated`), plus an Any/All (`statusMode`) radio pair, using the already-exported `parseStatusParam`/`parseStatusModeParam` helpers from `src/lib/search.ts`. The existing format filter (`parseFormatParam`) is unchanged. No ownership-type filter is added — `/books` is scoped to physical copies by definition (its query is `Book.findMany` filtered on `copies.some(...)`), so a physical/ebook/audiobook toggle wouldn't mean anything here.

The status-condition-building logic (mapping each `to_read`/`reading`/`read`/`unrated` value to a Prisma `where` clause, combined via `AND`/`OR` depending on `statusMode`) currently lives inline inside `searchCatalog` in `src/lib/search.ts`. It's extracted into a standalone exported function:

```ts
export function buildStatusWhere(
  statusValues: ReadStatusFilterValue[] | undefined,
  statusMode: StatusFilterMode,
): Prisma.BookWhereInput | undefined
```

`searchCatalog` calls this instead of building the clause inline (no behavior change — same logic, just named and reusable). `/books/page.tsx` calls it directly and adds the result to its own `AND` filter array alongside the existing query/format conditions.

## /tbr search box + alphabetical jump list

**Search box:** a `q` query param, server-rendered via a GET form (no client JS), filtering by title/author case-insensitive substring match — same pattern as every other search box in the app.

**Sorting and grouping:** `computeTbrGap()` currently returns items in arbitrary DB order. A sort key is introduced: `author` if present (trimmed), else `title` (trimmed). The full result list is sorted by that key. A new pure helper groups the (possibly search-filtered) list by the first character of that same sort key, uppercased:

```ts
export function groupByInitial(
  items: TbrGapItem[],
): { letter: string; items: TbrGapItem[] }[]
```

Non-letter first characters (digits, symbols, or any other edge case) fall into a single `#` bucket. Letters with zero matching items simply don't appear in the returned array — the page never renders an empty section or a jump-nav link with nothing to jump to.

**Query filtering vs. caching:** `getTbrGap()` is extended to accept an optional `query?: string`. The expensive fuzzy-match computation (`computeTbrGap()`, which excludes anything already owned) stays cached exactly as today — keyed on the full unfiltered gap, revalidated every 30 minutes or on-demand after a manual sync. The `query` filter is applied in-memory, after the cache lookup, against the already-computed (and now sorted) full list. Filtering ~800 in-memory items per request is cheap; adding `query` to the cache key would not be worth the added cache-invalidation complexity for that saving.

**Rendering:** the jump nav renders as plain `<a href="#letter-X">` anchors above the list; each letter group renders under a `<h2 id="letter-X">` header. Since this is a server-rendered, full-page-reload architecture (matching the rest of the app), the anchors are ordinary same-page fragment links — no JS required.

## Non-goals

- No client-side/JS-driven filtering anywhere — every page in this app uses a GET form + query params, and this phase doesn't deviate from that.
- No pagination on `/tbr` — the jump nav is the navigation aid; the list itself still renders in full.
- No changes to the home page's existing filter UI — it's already correct; this phase only brings the other two pages up to parity with it.
- No format/status/rating filter on `/tbr` — that data doesn't exist for TBR items (`GoodreadsTbrItem` only has `title`/`author`/`isbn`/`lastSyncedAt`), so there's nothing to filter on beyond text search.

## Testing

No page-level (`.tsx`) tests exist anywhere in this codebase today — all testing lives at the `src/lib/*.test.ts` layer, with pages kept thin and manually/Playwright-verified. This phase follows the same convention:

- `src/lib/search.test.ts`: `buildStatusWhere` unit tests (each status value, `unrated`, Any vs. All mode, undefined/empty input), plus confirmation `searchCatalog`'s existing behavior is unchanged now that it calls the extracted function.
- `src/lib/tbrGap.test.ts`: `groupByInitial` (author-present vs. author-null sort-key fallback, `#` bucket, empty-letter omission, case-insensitivity of the first-character grouping), and `getTbrGap(query)` (matches on title, matches on author, no match, empty/undefined query returns everything).
