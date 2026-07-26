# Series Tracking — Design Spec

## Goal

View which books in the catalog belong to the same series, in order, directly from a book's detail page. Closes one of the three items carried since the original v1 design spec's "Deferred / Future Ideas" section (`docs/superpowers/specs/2026-07-05-book-catalog-design.md`).

## Background

Goodreads' shelf RSS feed (the source for `syncGoodreadsTbr`/`syncOwnedPhysicalBooks`, see `src/lib/goodreadsSync.ts`) has no structured series field — confirmed by fetching a real shelf feed live during design. Series membership is only ever embedded in the feed's own `<title>` value, following Goodreads' own long-standing convention:

```
Title (Series Name, #N)
```

For example, a real entry from this user's own "read" shelf:

```xml
<title><![CDATA[The City of Brass (The Daevabad Trilogy, #1)]]></title>
```

`shelfItem.title` is stored verbatim into `Book.title` today, with no stripping or transformation (confirmed via `src/lib/goodreadsSync.ts` and `src/lib/ownedPhysicalSync.ts` — both pass the raw parsed title straight into the Prisma create call). This means the user's existing library already has series-annotated titles sitting in the database, unparsed.

Since Goodreads' feed provides no better source, and the format isn't guaranteed to be present on every title (many manually-scanned physical books have no series), this feature parses the convention out of the *existing* title string as a best-effort default, with manual override for everything the parse can't cover.

## Data model

Add three columns to `Book`:

```prisma
model Book {
  // ...existing fields...
  seriesName     String?
  seriesPosition Float?
  seriesManual   Boolean @default(false)
}
```

- `seriesPosition` is `Float`, not `Int`, so novellas/interstitial entries (e.g. "1.5") can be recorded.
- `seriesManual` mirrors the existing `readStatusManual`/`ratingManual` convention exactly: `false` means "derived/parsed automatically, safe to leave alone or re-derive"; `true` means "the user has hand-edited this, never overwrite it automatically."
- No index is added on `seriesName` — this app's whole catalog is a personal library (hundreds, not millions, of rows), and the only query pattern is "find other books sharing this exact series name," a full-table scan-and-filter that's already fast enough at this scale (matches the precedent set by `findDuplicateBookGroups`' own un-indexed full-catalog scan before its performance work, at a scale far larger than one user's series groupings will ever reach).

## Parsing

A single pure function, `parseSeriesFromTitle(title: string): { seriesName: string; seriesPosition: number } | null`, implements the regex extraction:

```
/^(.+) \(([^,()]+), #(\d+(?:\.\d+)?)\)$/
```

- Group 1: everything before the trailing `(...)` — not stored or used; `Book.title` itself is never modified by this feature (see Non-goals).
- Group 2: the series name, trimmed.
- Group 3: the position, parsed as a float.
- No match (most manually-scanned physical books, or any Goodreads title that doesn't follow the convention) → the function returns `null`, and both fields stay `null` until the user fills them in by hand on the edit page.

**When parsing runs:**

1. **At `Book` creation time**, for any book created from a Goodreads-sourced title — both `syncGoodreadsTbr`'s TBR-item-to-Book promotion path and `syncOwnedPhysicalBooks`'s new-Book-creation path. `seriesManual` stays `false` on these auto-derived rows.
2. **One-time backfill**, as **pure SQL inside the same migration that adds the columns** — no script, no button, no manual step. Matches the confirmed precedent in `prisma/migrations/20260716192026_unify_copy_types/migration.sql`, and runs automatically on deploy, since `docker-entrypoint.sh` executes `prisma migrate deploy` at container startup.

   **Corrected 2026-07-26.** An earlier draft of this spec asserted "the regex isn't expressible as plain SQL" and proposed a companion TypeScript function run manually per environment. That was wrong on both counts. Postgres's `regexp_match` handles the pattern exactly, verified against every case in the Testing section below:

   | Input | `regexp_match` result |
   |---|---|
   | `The City of Brass (The Daevabad Trilogy, #1)` | `{"The City of Brass","The Daevabad Trilogy",1,NULL}` |
   | `Some Novella (Series Name, #1.5)` | `{"Some Novella","Series Name",1.5,.5}` |
   | `Book Title (Annotated Edition)` | no match |
   | `Plain Title With No Suffix` | no match |
   | `Title (Something, No Number)` | no match |

   That same draft also claimed "there is no `scripts/` directory in this repo" — true when written, false since PR #35, which added `scripts/backfill-tbr-owned.ts` and `tsx`. Neither is needed here.

   **On having the regex in two places** (TypeScript for new rows, SQL for the backfill): acceptable *because a migration is a frozen, run-once artifact*. The two only need to agree at the moment the migration applies; afterwards the SQL never executes again, so drift cannot cause a bug. This is explicitly unlike the TBR ownership work, where the CLI script and the UI button both keep running and therefore had to share one implementation.
3. **Never automatically overwritten** once `seriesManual` is `true` — matches the existing manual-override convention.

Books added manually (scan flow, `/books/new`) never go through this parser at all — their `title` never contains a Goodreads-style series suffix, so `seriesName`/`seriesPosition` simply start `null`, same as any other unparsed title.

## Manual editing

`/books/[id]/edit` gains two new fields. **They belong in `EditBookForm` itself, not in the shared `BookFormFields` component** — `BookFormFields` renders the title/author/isbn inputs for `/books/new` as well, so putting series fields there would surface them on the add flow too, contradicting the edit-page-only decision below. (Noted 2026-07-26; the original draft said "alongside the existing title/author/isbn fields in `EditBookForm`", which reads as if those fields live there.)

The two fields:

- **Series name** — plain text input, optional.
- **Series position** — numeric input (`type="number" step="0.5"` or similar, accepting decimals), optional.

Saving either field (via a new `updateSeries` server action, mirroring `updateReadStatus`/`updateRating`'s existing shape) sets `seriesManual = true` and both fields directly from form input — clearing both fields back to empty is allowed (a user un-recording series membership entirely), and does **not** reset `seriesManual` back to `false` (once hand-edited, always hand-edited, matching the existing rating/status convention where "Let Goodreads manage this again" is a distinct, explicit action, not an implicit side effect of clearing a value). No separate "let auto-parsing manage this again" control is added — see Non-goals.

## Detail-page display

On `/books/[id]`, a new section appears **only when both** of these hold:

1. This book has a non-null `seriesName`.
2. At least one *other* book in the catalog has the exact same `seriesName` (case-insensitive, trimmed comparison) — a "series" of one book showing itself provides no value.

When shown, it renders as:

```
Part of: {seriesName}
1. {other book title}          [link to /books/{id}]
2. {this book title} (this book)
3. {other book title}          [link to /books/{id}]
```

- Ordered by `seriesPosition` ascending; books with a `null` position sort after every book that has one (stable order otherwise — ties broken by `title`, matching this app's existing `sortBy: "title"` tiebreak convention from `searchCatalog`).
- The current book is shown in the list (not filtered out), marked distinctly (e.g. "(this book)"), not a link to itself.
- Every *other* book's series entry links to that book's own `/books/{id}` detail page.
- No `/series` browse/index page — this is deliberately scoped to "see the other books in this one's series," not a general series catalog view.

## Non-goals

- **No changes to `Book.title` itself** — the stored/displayed title stays exactly as it is today, including the raw Goodreads series suffix where present. This feature is purely additive: new fields alongside the existing title, not a replacement for or transformation of it.
- **No series fields on `/books/new` or the scan-confirm flow** — series info is edit-page-only, matching how read status/rating already work.
- **No dedicated `/series` browse page** — only the per-book "other books in this series" cross-link section on the detail page.
- **No re-parsing on an ongoing basis** — parsing happens once, at creation (or once, at backfill, for pre-existing rows).

  **Corrected 2026-07-26.** An earlier draft justified this with "`Book.title` never changes post-creation in this app". That is false: `updateBookData` (`src/lib/books.ts`) writes `title` every time the edit page is saved. The original claim was only ever true of the *sync* paths, which never overwrite an existing book's title.

  The non-goal still stands, for a better reason: the only way a title changes is a deliberate user edit, made on the very page that also exposes the series fields. Silently re-deriving series from the new title there would fight the edit the user is in the middle of making — and would be especially wrong once `seriesManual` is set. If a retitle should change the series, the user changes it in the field right below.
- **No "let Goodreads manage this again" unwind control for series** — unlike read status/rating (which really do keep changing on Goodreads over time, making an unwind meaningful), a title's series suffix is fixed at creation, so there's nothing for un-setting `seriesManual` to meaningfully "resume."
- **No fuzzy matching on series name** — exact (trimmed, case-insensitive) string equality only, to avoid falsely grouping two different series that happen to share similar names.
- **No handling of series-of-series, sub-series, or reading-order-vs-publication-order distinctions** — `seriesPosition` is one flat number per book; anything more structured is out of scope.

## Testing

- `parseSeriesFromTitle`: pure-function unit tests — matches the real example above; matches an integer position; matches a decimal position (novella); returns `null` for a title with no parenthetical suffix; returns `null` for a title with an unrelated parenthetical (e.g. "Book Title (Annotated Edition)" — no comma, no `#N`, must not false-positive); returns `null` for a title whose parenthetical has a comma but no `#N` marker.
- Backfill script: given a small set of existing `Book` rows (some matching the pattern, some not, one already having a manually-set `seriesManual: true` value that must NOT be touched), running the backfill sets `seriesName`/`seriesPosition` only on the rows that both match the pattern and currently have `seriesManual: false` with `seriesName` still `null`.
- Creation-time parsing: a new test in each of `goodreadsSync.test.ts`/`ownedPhysicalSync.test.ts` confirming a newly-created `Book` from a series-annotated shelf title gets `seriesName`/`seriesPosition` populated, `seriesManual: false`.
- `updateSeries` action: sets both fields and `seriesManual: true`; confirms a subsequent backfill/creation-time parse (simulated) does not overwrite a manually-set row.
- Detail-page series section: a real render/query test (matching this project's established "seed real rows, query for real, assert on real output" convention rather than a snapshot) confirming — the section is absent when `seriesName` is null; absent when this is the only book with that `seriesName`; present and correctly ordered (including a null-position book sorting last) when 2+ books share a series name; the current book is marked and not a link; sibling books link to their own detail pages.
