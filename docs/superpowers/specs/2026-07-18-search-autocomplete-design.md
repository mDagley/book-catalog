# Search Autocomplete — Design

## Overview

The home page, `/books`, and `/tbr` each have a plain text search box (type a query, submit, get results) with no suggestions as you type. This phase adds a typeahead dropdown to all three, sourced from each page's own existing data — the home page suggests across the whole catalog, `/books` suggests physical-book titles/authors, `/tbr` suggests TBR item titles/authors. Selecting a suggestion (click or keyboard) immediately submits the search, matching how the rest of this app favors minimal-friction, single-step interactions.

This is the first genuinely interactive search box in the app — every other search box today is a plain server-rendered `<input>` inside a GET `<form>`. That's not a new architectural direction: the app already uses client components for other interactive pieces (`CoverEditor`, `BarcodeScanner`, `CoverCamera`); this just extends that same pattern to search.

## Section 1: Suggestion API

One shared route, `src/app/api/autocomplete/route.ts`, handling `GET /api/autocomplete?scope=<home|books|tbr>&q=<text>`.

- `scope` is validated against an allowlist (`home`, `books`, `tbr`); any other value (or missing) returns 400.
- `q` must be at least 2 characters after trimming; anything shorter returns an empty array without querying the database — avoids firing a query on the first keystroke.
- Each scope queries the exact table/shape that page's own search already uses:
  - `home`: `prisma.book.findMany({ where: { OR: [{ title: { contains: q, mode: "insensitive" } }, { author: { contains: q, mode: "insensitive" } }] }, select: { title: true, author: true }, take: 8, orderBy: { title: "asc" } })` — same unscoped-by-ownership shape the home page's own search already uses.
  - `books`: identical query shape, same table — deliberately matching `/books`' own current (not-yet-fixed) behavior of not requiring a physical copy, rather than silently diverging from what that page's own search actually returns. If backlog item #7 (`/books` zero-physical-copy gap) is ever fixed, this route's `books` scope should be revisited at the same time.
  - `tbr`: `prisma.goodreadsTbrItem.findMany({ where: { OR: [...] }, select: { title: true, author: true }, take: 8, orderBy: { title: "asc" } })`.
- Response: `{ title: string; author: string | null }[]`, capped at 8 entries.

## Section 2: Shared `<SearchAutocomplete>` client component

New file, `src/components/SearchAutocomplete.tsx` (client component). Props: `scope: "home" | "books" | "tbr"`, `name: string`, `defaultValue: string`, `placeholder: string` — mirrors the props each page's existing `<input>` already takes, so it's a drop-in replacement inside each page's existing `<form>`.

- Debounces input changes (~250ms) before fetching `/api/autocomplete?scope={scope}&q={value}`; fetches are skipped entirely below the 2-character threshold (matching the API's own minimum, so no wasted requests).
- Renders a dropdown below the input listing up to 8 suggestions, each showing title (primary) and author (secondary, when present) — this directly implements your "match against both, suggest by title" choice.
- Keyboard support: Up/Down arrows move a highlighted-item index (wrapping at the ends), Enter selects the currently highlighted suggestion (or, if nothing is highlighted, lets the keypress fall through to normal form submission), Escape closes the dropdown without changing the input.
- Selecting a suggestion — by click or by Enter on a highlighted item — sets the input's value to that suggestion's title and immediately submits the enclosing `<form>` (`form.requestSubmit()`), matching the "auto-submit" behavior you chose.
- Clicking outside the dropdown closes it without changing anything.

## Section 3: Wiring into the three pages

- `src/app/page.tsx` (home): the existing `<input type="text" name="q" defaultValue={query} placeholder="Do I already own this?" className="..." />` is replaced with `<SearchAutocomplete scope="home" name="q" defaultValue={query} placeholder="Do I already own this?" />`.
- `src/app/books/page.tsx`: same replacement, `scope="books"`, its existing placeholder text.
- `src/app/tbr/page.tsx`: same replacement, `scope="tbr"`, its existing placeholder text.
- No other changes to any of the three pages — filters, results rendering, the rest of each `<form>`, and everything else stays exactly as it is today.

## Non-goals

- No fuzzy/typo-tolerant matching — plain substring `contains`, matching how every other search/filter in this app already works (no reuse of the fuzzy title-matching machinery in `src/lib/matching.ts`, which exists for a different problem — reconciling external sync data against existing rows, not live user typeahead).
- No caching or prefetching of suggestion results.
- No suggestions spanning multiple scopes at once (e.g. `/tbr`'s box never suggests owned-catalog titles).
- No change to how the actual search/filter results themselves are computed on any of the three pages — this only adds a suggestion dropdown in front of the existing search flow.
- No fix for the `/books` zero-physical-copy gap (backlog item #7) — this phase's `books` scope deliberately mirrors that page's current behavior rather than fixing it as a drive-by.

## Testing

- `src/app/api/autocomplete/route.test.ts` (new): each scope returns matching title/author pairs from real DB fixtures; a `q` under 2 characters returns `[]` without touching the DB (verifiable via a fixture that would otherwise match); an invalid/missing `scope` returns 400; results are capped at 8; `/books` scope matches a Book with zero physical copies (confirming intentional parity with that page's current listing behavior, not an oversight).
- `SearchAutocomplete` component behavior (keyboard nav, debounce, selection-submits) is UI/interaction logic without an existing testing convention in this codebase — the one existing test file under `src/components/` (`ReadingProgressFields.test.ts`) only tests a pure exported helper function, not component rendering/interaction, and no interactive component (`CoverEditor`, `BarcodeScanner`, `CoverCamera`) has ever had its rendered behavior under test. Verified via manual browser QA instead, consistent with how those components were verified.
