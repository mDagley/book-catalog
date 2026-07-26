# Library Stats — Design Spec

## Goal

A `/stats` page giving an at-a-glance picture of the library: how big it is, what's in it, what's been read, and what's still on the to-read shelf. Closes the last outstanding item from the original v1 design spec's "Deferred / Future Ideas" list (`docs/superpowers/specs/2026-07-05-book-catalog-design.md`), alongside series tracking (`2026-07-20-series-tracking-design.md`, still unbuilt).

Purpose, per the user: **both a curiosity snapshot and a mildly practical tool, weighted toward curiosity.** It should be satisfying to look at; where an actionable number is cheap to include, include it.

## Architecture: plain per-request queries, no cache, no persisted column

Every figure on this page is a `COUNT` or a `GROUP BY` executed inside Postgres. Measured against a 2000-book fixture with one physical copy each:

| Query | Time |
|---|---|
| **All 11 stats queries, in one `Promise.all`** | **38ms** |
| `groupBy` read status | 2ms |
| `groupBy` top 10 authors | 1ms |
| Publish-decade histogram (raw SQL) | 2ms |

**This deliberately departs from [[caching-preference]]**, which says to prefer persisting a derived answer over recomputing per request. That principle earned its place from the TBR gap, where the work was O(books × TBR items) of *fuzzy string matching in application code* — 49 seconds. Stats are O(n) aggregates with a tiny constant, executed by the database. At 38ms for the entire page, a persisted stats table would cost more in invalidation bookkeeping (every book, copy, rating, and status change would have to touch it) than it could ever save. Adding that machinery here would be the over-engineering, not the discipline.

The distinction worth carrying forward: *the preference is against expensive recomputation, not against computation.*

No caching layer either — the same reasoning that removed `unstable_cache` from `getTbrGap` (`2026-07-25-performance-fixes-design.md`) applies from the start here.

## Data layer

One new module, `src/lib/stats.ts`, exporting:

```ts
export interface LibraryStats { /* ...shape below... */ }
export async function getLibraryStats(): Promise<LibraryStats>
```

All queries issued in a single `Promise.all`. No arguments — the page is unfiltered by design (see Non-goals).

### Counting rules (stated explicitly, because mixing these is how stats pages stop reconciling)

- **Book-level counts** answer "how many titles": total books, ownership by type, read status, ratings, top authors.
- **Copy-level counts** answer "how many physical objects": total copies, format breakdown, publishers, publish years. Two paperbacks of one title count twice in format counts and once in book counts.
- Every section states which unit it is using, in the UI, not just here.

A book counts as owned in a format if it has ≥1 copy of that kind: `copies.length > 0` (physical), `hasEbook`, `hasAudiobook`.

## Page content

Route: `/stats`, linked from the home page alongside the existing "Manage all books" / "TBR gap view" links.

### 1. At a glance — stat tiles, not charts

Per the visualization guidance, a handful of headline numbers is a KPI row, **not** a one-bar chart:

- Total books (the hero figure — largest type on the page)
- Total copies
- Owned physically / as ebook / as audiobook
- Owned in more than one format

### 2. Reading

- **Read status** — read / reading / to-read / no status set. Book-level. `readStatus` is nullable (a book never touched by a Goodreads shelf sync has none), and "no status set" is shown as its own bar rather than silently folded into "to-read" — those mean different things.
- **Ratings** — a 1–5 histogram plus an explicit unrated count. Book-level.

### 3. Physical shelf

- **Format** — hardcover / paperback / mass market / other. Copy-level.
- **Top 10 publishers**. Copy-level.
- **Publish decade** — an ordered histogram bucketed by decade. Copy-level, `publishYear` nullable; rows without one are excluded and the excluded count is stated.

### 4. Authors & TBR

- **Top 10 authors** by number of books. Book-level; `author` is nullable and null is excluded, not bucketed as "Unknown" (a missing author is absent data, not an author).
- **TBR** — total items on the to-read shelf, how many are already owned, and the remaining gap. Reads the `owned` column added in `2026-07-25-performance-fixes-design.md`, so it costs two `COUNT`s rather than any matching work.

## Visual treatment

### Single-hue bars, no charting library

Every visualization on this page is a single-series horizontal bar or histogram: **length carries the data, colour carries nothing.** A charting library's value — multi-series legends, scales, categorical palettes, axis machinery — has nothing to apply itself to here. These are built as plain HTML/CSS in server components, using the existing theme tokens.

### The palette forces this, and that is measured, not assumed

The Sakura Postal theme's two candidate data colours cannot be used to distinguish series. Validated with the visualization skill's palette checker:

| Pair | Normal vision | Deuteranopia | Verdict |
|---|---|---|---|
| Sakura `#D98A96` vs Bamboo `#7C8B6F` (light) | ΔE 18.8 | ΔE 10.7 | marginal |
| Sakura Ink `#9C4258` vs Bamboo `#5F6B54` (light) | ΔE 14.6 | **ΔE 0.2** | **unusable** |
| Night Sakura `#E8A2AC` vs Moss `#9CAE8A` (dark) | ΔE 13.3 | ΔE 4.8 | **unusable** |

Two of these fall below the ΔE 15 normal-vision hard floor, and the deuteranopia figures mean a red-green colourblind reader would see two series as one colour. **Any multi-series categorical chart in this theme would be unreadable.** Single-hue is therefore a requirement, not a stylistic preference — and if a future feature genuinely needs categorical series, the theme needs new tokens first.

### Bar fill

Reuses the existing `--link` token — `#9C4258` (light) / `#E8A2AC` (dark) — which **passes the ≥3:1 contrast-vs-surface check in both modes**. Note `--accent` (`#D98A96`) does **not**: it measures 2.15:1 on the cream surface, the same shortfall that caused `--link` to be introduced during the theme work. Bars must not use `--accent`.

Dark mode uses a hand-picked value from the existing token rather than an automatic flip, matching how the rest of the theme handles it.

### Anatomy

- Horizontal bars, 4px rounded data-ends anchored to a common baseline, 2px gap between adjacent bars.
- **The numeric value is always rendered as text beside its bar**, never encoded in length alone. This satisfies the accessibility obligation directly and means the page reads as a table for a screen reader or a colourblind reader without a separate table view.
- Category labels in normal text tokens, never in the series colour.
- Recessive baseline; no gridlines (the printed values make them redundant at this density).
- Native `title` attributes carry the exact count on hover — the guidance's hover layer, with no client-side JS and no `"use client"` boundary.
- Empty state: a library with zero books shows a short "Nothing catalogued yet" message rather than a page of zeroes and empty bars.

## Non-goals

- **No trends over time.** `Book.createdAt` records when a row was *synced or scanned*, not when the book was acquired or read. A "books added per month" chart would look meaningful and be misleading — the whole library would spike on whatever day the first ABS sync ran.
- **No date-range or dimension filters** — this is a whole-library snapshot. `/books` already exists for filtered browsing.
- **No per-author or per-publisher drill-down pages.** The top-10 lists are read-only; clicking through belongs to `/books`' existing search.
- **No multi-series or stacked charts** — see the palette measurements above.
- **No charting library dependency.**
- **No caching, no persisted stats table, no materialized view.**

## Testing

Following this project's convention of seeding real rows and asserting on real query output (no Prisma mocking):

- `getLibraryStats` totals: counts books and copies separately and correctly when one book has multiple physical copies — the specific case where book-level and copy-level numbers must diverge.
- Ownership: a book with both a physical copy and `hasEbook` counts once in total books, once in physical, once in ebook, and once in "more than one format".
- Read status: a book with `readStatus: null` lands in "no status set", not in "to-read".
- Ratings: unrated books (`rating: null`) are counted separately from any 1–5 bucket, and the buckets sum with unrated to the total book count.
- Top authors: books with `author: null` are excluded entirely rather than grouped under a null key; ties are ordered deterministically.
- Publish decades: `publishYear: null` copies are excluded and reported as an excluded count; a 1998 copy buckets to 1990.
- TBR: owned and unowned counts sum to the total TBR item count.
- Empty library: `getLibraryStats` returns zeroes without throwing, and the page renders its empty state.
- Reconciliation: a single test asserting the sections agree — read-status buckets sum to total books, format buckets sum to total physical copies. This is what catches a future edit that silently mixes book-level and copy-level counting.
