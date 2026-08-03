# Books List Density & Findability — Design Spec

## Goal

Make `/books` usable at real library scale. Today it shows **3 books per screen** on desktop and **2 on a phone**; at ~1800 books that is **560 screens of scrolling**. The user's report: "each book row is large and it is cumbersome to scroll through the large library of books."

Two halves: make rows denser, and make it possible to reach a book without scrolling at all.

Priorities set by the user: this is a **small personal project** — ease of use and finding things quickly matter; accessibility polish is explicitly lower priority (one exception, noted in Non-goals).

## Measured baseline

All measured in the running app at 60 books, desktop 1280×900 and phone 390×844:

| | Current |
|---|---|
| Row height / pitch | 268px / **280px** |
| Books visible on first screen (desktop) | **2** (275px of filter chrome sits above the list) |
| Books per screen once scrolling (desktop) | **3** |
| Books per screen (phone 390×844) | **2** |
| Scroll distance for 1800 books | **~560 screens** |

The cause is structural: `CoverThumbnail` renders a **128px-tall block above** the text (`h-32 w-24`, `mb-2`), not beside it, and "View details" takes its own line below the meta row.

Layout alternatives, simulated by injecting CSS into the live page and re-measuring:

| Layout | Pitch | Per screen | Screens for 1800 |
|---|---|---|---|
| Current | 280px | 3 | 560 |
| Cover beside text, no "View details" line | 166px | 5 | 332 |
| **↑ plus a 48×64 cover** | **102px** | **8** | **204** |
| Text only, no cover | 74px | 12 | 148 |

**Chosen: the 102px row.** 2.7× the density while keeping covers. Dropping covers entirely buys only 1.4× more on top of that and discards the recognition value of art the user built a dedicated burst-capture/crop tool to collect.

## Relationship to pagination (why the page size does not change much)

`/books` is paginated because of load time, not layout: before PR #35 it rendered the whole catalogue as **4.3MB of HTML in 2.3–2.9s**. `DEFAULT_PAGE_SIZE = 50` and `MAX_PAGE_SIZE = 500` exist to bound that, and this spec must not quietly undo it.

The obvious question is whether a lighter compact row lets the page size rise. Measured against a 600-book fixture:

| `?limit=` | Bytes | Time |
|---|---|---|
| 10 | 60.6 KB | 0.08s |
| 50 (today's default) | 207 KB | 0.13s |
| 100 | 390 KB | 0.23s |
| 200 | 764 KB | 0.37s |
| 400 | 1.51 MB | 0.51s |
| 500 (today's cap) | 1.88 MB | 1.03s |

That is a clean linear ~**3.7 KB per row** on top of ~23 KB of page chrome.

**A compact row is only marginally lighter, so density does not buy a bigger page.** Breaking down the payload for 100 rows: **70% is React Server Component flight data and only 29% is rendered markup** — so the content is serialised roughly twice, and every element removed is counted twice. The parts this spec removes (the `TicketDivider`, the "View details" link, publisher/year text) come to roughly 26 KB of 390 KB, i.e. **on the order of 10%**. Real, but nothing like the 2.7× visual gain.

**Conclusion: keep `DEFAULT_PAGE_SIZE = 50` and `MAX_PAGE_SIZE = 500`.** The win comes from the same page going much further, not from loading more:

| | 50 rows/page |
|---|---|
| Today (280px row) | 14,000px ≈ **15 screens** per Load-more click |
| Compact (102px row) | 5,100px ≈ **5 screens** per click |

The cap also still earns its place: at 500 rows the page is 1.88 MB and crosses a second — and because "Load more" accumulates server-side, that is the real ceiling being bounded.

If fewer clicks are wanted later, raising the default to 100 is measured as safe (390 KB / 0.23s) and is a one-constant change — but it is deliberately **not** part of this work, because the density change alone already cuts clicks by 2.7× and changing both at once would make it impossible to tell which one helped.

## Density toggle

`CatalogResultCard` is currently **shared** between `/` and `/books` and its own comment notes both "render `searchCatalog()` results identically". The two tasks are opposites: `/` answers "do I already own this?" (few results, confirming an edition — the large cover is doing real work), `/books` is scanning a large library (density wins).

Rather than forking the component permanently, it gains a **density variant**, user-switchable per view:

- **`comfortable`** — today's card, unchanged.
- **`compact`** — the 102px row specified below.

### Persistence

Stored in a **cookie**, one key per view (e.g. `density-books`, `density-home`).

Cookie rather than `localStorage` because this app is server-component-first: a server component can read the cookie during render, so the correct density is in the first HTML with **no hydration flash and no client state library**. `localStorage` would require a client component and would flicker.

**Verified constraint:** in this Next version `cookies()` is async, and `.set()` may only be called from a **Server Function or Route Handler — not during a server-component render** (confirmed against `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`). The toggle is therefore a small `<form>` posting to a server action that sets the cookie and calls `revalidatePath`, not a plain `<Link>`.

### Defaults

- `/books` → **compact** (browsing)
- `/` → **comfortable** (confirming)

A user toggle overrides the default for that view and persists. Absent cookie = the default above.

## Compact row contents

Per the user's selection. Title and author always; then:

- **Cover, 48×64**, beside the text (not above). Same `CoverThumbnail` fallback treatment at the smaller size.
- **Read status + rating** — the two fields most likely to drive a browse decision.
- **Format / ebook / audiobook badges** — which forms are owned.
- **Publisher and publish year are removed from the row.** They remain on the detail page. They are the bulk of today's meta line and are rarely what you scan for.

**The whole row is the link** to `/books/[id]`. This removes the separate "View details" line entirely *and* replaces a 20px text link with a full-row tap target — material on a phone, which is where scanning happens.

Long titles truncate to a single line with ellipsis rather than wrapping, so row pitch stays uniform and the list scans as a column. The full title is available on the detail page and via the `title` attribute.

## Sorting

`/books` currently has no sort control and is always title A–Z. Adding, per the user's selection:

| Option | Order | Null handling |
|---|---|---|
| **Title A–Z** (default, today's behaviour) | `title asc`, `id asc` tiebreak | — |
| Author A–Z | `author asc`, then `title asc` | authorless books **last** |
| Recently added | `createdAt desc`, then `id desc` | — |
| Rating high→low | `rating desc`, then `title asc` | unrated books **last** |

**Sorting happens in the database, not in memory** — it must precede the `LIMIT`, or a paginated list sorts only the rows it already fetched. `searchCatalog`'s `sortBy` currently accepts only `"id" | "title"` and is extended.

**Verified:** Prisma's `orderBy: { field: { sort, nulls: "last" } }` works correctly in this version — probed directly (`rating desc nulls last` → 5, 3, null; `author asc nulls last` → Amy, Zed, null). Note this contradicts the caution recorded in the series-tracking work, which sorted in memory to avoid version-varying null support; that caution was reasonable when written but is not needed here, and in-memory sorting is not an option anyway once pagination is involved.

Every sort carries a deterministic tiebreak. Ranked lists on `/stats` shipped with reshuffling-between-loads because ties had no secondary key; that must not recur.

## Result count

Above the list: **"Showing 50 of 214 books"** (and simply "214 books" when everything fits).

Today a filter gives no indication of how much it matched — narrowing to "Paperback + Unrated" could be 6 books or 600 and you cannot tell without scrolling to the end. This is the cheapest item here and directly serves "find what I'm looking for quickly".

Requires one additional `count()` alongside the page query, with the same `where`. Cheap: the `/stats` work measured 17 aggregate queries at a median of 3ms against a 2000-book fixture.

## Jump-to-letter

`/tbr` has an alphabet strip; `/books` — the far larger list — does not.

**It cannot be built the way `/tbr` builds it.** `/tbr` loads its whole list and the strip is in-page anchors into letter-grouped sections. `/books` is paginated at 50, so an anchor to "M" would only reach rows that happen to be loaded. On a paginated list a letter must be a **server-side filter**, not an anchor:

- Each letter links to `?startsWith=M`, combining with existing filters and sort.
- The active letter is visually marked, with a "clear" affordance back to the unfiltered list.
- Matching is on the **current sort's field**: title under Title A–Z, author under Author A–Z.
- **Shown only under the Title and Author sorts.** An alphabet strip is meaningless beside "recently added" or "rating high→low", so it is hidden for those.
- Bucketing reuses `/tbr`'s existing `letterBucket` semantics (diacritics stripped, non-letters under `#`) so both lists agree on what "browsing alphabetically" means.

## Filter chrome

275px of always-expanded filter controls sits above the first row, which is why only 2 books are visible on first paint despite a 900px viewport.

The filter block collapses to a single summary row when no filter is active (e.g. "Filters"), expanding on click. When any filter *is* active it renders expanded, so active filters are never hidden — a filtered list that looks unfiltered is worse than the height it saves.

Search box, sort control and result count stay always-visible; only the filter controls collapse.

## Non-goals

- **No virtualised list.** "Load more" plus a 102px row plus real filtering and jump-to-letter is sufficient at this scale; virtualisation adds real complexity and breaks in-page find (Ctrl-F), which is itself a findability tool.
- **No change to `DEFAULT_PAGE_SIZE` or `MAX_PAGE_SIZE`** — see the pagination section above. Those constants exist for a measured load-time reason and the density work does not materially change the payload maths.
- **No change to `/tbr`'s existing jump nav** — it is unpaginated and its anchors work.
- **No infinite scroll.** "Load more" stays explicit; infinite scroll makes reaching the footer and reasoning about position harder.
- **No accessibility work from the 2026-07-26 UX assessment** (live regions, search-input labels, focus-ring contrast) — deliberately deferred by the user for a single-user app.
- **Except:** the assessment's finding that `/books/duplicates`' merge destroys an unbounded number of books with no confirmation and no undo is a **data-loss** issue, not an accessibility one. Out of scope here, but it should not be lost. Tracked separately.

## Testing

Following this project's convention of seeding real rows and asserting on real query output:

- `searchCatalog` sorting: each of the four sorts returns the expected order, including the two null-position rules (authorless last, unrated last) and a deterministic tiebreak under each — assert stability by calling twice and comparing.
- Sorting is applied **before** the limit: with `limit: 2` over a known 5-book fixture, the two rows returned are the first two of the *full* sort, not two arbitrary rows re-sorted.
- Result count: matches the total for the active filters, and is independent of `limit`.
- `startsWith` filter: matches on title under title sort and author under author sort; combines correctly with existing type/format/status filters; respects `letterBucket`'s diacritic and `#` rules.
- Density cookie: absent cookie yields the per-view default; a set cookie is honoured; the toggle action writes it and the next render reflects it.
- Browser verification at realistic scale, both densities, light and dark, desktop and 390px: measured row pitch is ~102px in compact; books-per-screen improves as specified; the whole row navigates; long titles truncate rather than wrap; filter block collapses when unused and is expanded when a filter is active.
