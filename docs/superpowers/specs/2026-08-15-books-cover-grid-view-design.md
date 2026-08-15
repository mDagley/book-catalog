# Books Cover Grid View — Design Spec

## Goal

Bring the cover-forward grid layout from the user's other project (`family-book-club`, `/suggestions` page, source at `../BookClub`) into this catalog's browse experience. Scope, per the user's answers during brainstorming:

- **Layout only.** Keep this app's existing "Sakura Postal / Library Ticket" theme (light postal palette, dashed-perforation card borders, panda stamp). No dark theme, no vote arrows, no genre tags — those are `family-book-club` concepts this catalog doesn't have.
- **Applies everywhere** book listings appear: `/books`, `/` (home search), `/books/[id]` detail, `/books/duplicates`.

Reference material used: a live walkthrough of `/suggestions` (grid and list views) and the actual source — `src/components/suggestions/CoverCard.vue` and `CoverGrid.vue` in `../BookClub` — not just the screenshot.

## What carries over vs. what doesn't

| Reference has | Adopted? |
|---|---|
| Cover-forward grid, `2/3` aspect-ratio cover box | Yes |
| Corner badges over the cover (status, format) | Yes — adapted: `PandaStamp` read badge + new format icons |
| Grid/list view toggle | Yes |
| `auto-fill, minmax(160px, 1fr)` responsive grid | Yes |
| Vote arrows / vote count | No — no voting concept here |
| Genre icon strip | No — no genre tagging here |
| Dark "night forest" palette, gold accent | No — user chose layout-only; existing theme tokens stay |
| Description hover tooltip | No — not requested, adds scope |

## View mode: grid ⇄ list

A new per-view preference, `ViewMode = "grid" | "list"`, following the exact pattern `Density` already uses (`src/lib/density.ts`, `setDensity` action):

- New `src/lib/viewMode.ts`: `getViewMode(view: "books" | "home")`, cookie `view-books` / `view-home`.
- New `src/lib/actions/viewMode.ts`: `setViewMode` server action, same shape as `setDensity`, calls `revalidatePath`.
- Cookie-backed (not `localStorage`/client state) for the same reason density is: this app is server-component-first, so the correct view is in the first HTML response with no hydration flash.

### Defaults

- `/books` → **grid** (matches the reference site's default; browsing benefits from covers).
- `/` → **list** (a "do I already own this?" lookup is usually 1-3 results; the existing comfortable list card already shows a large cover per result, so a grid adds little).

A user toggle overrides the default for that view and persists, exactly like density does today.

### Interaction with density

Density (`compact`/`comfortable`) only means something in list view — grid cards are a fixed poster size. So:

- **Grid view**: only the grid/list toggle shows.
- **List view**: both the grid/list toggle and the existing density toggle show, unchanged from today.

## New component: `CoverGridCard`

`src/components/CoverGridCard.tsx`, alongside (not replacing) `CatalogResultCard`. Structure, following the reference's `CoverCard.vue`:

- Outer: `TicketCard` (`as="div"` — the grid `<ul>` still wraps items in `<li>`, so the card itself renders as a `div` inside an `<li>` grid cell, matching how `TicketCard`'s `as` prop is already used elsewhere).
- Cover box: `aspect-[2/3]` container, cover image (or the existing `📖` placeholder) filling it via `object-cover`.
- Corner badges, absolutely positioned over the cover box (`position: relative` on the cover box, matching the reference's `.cover-wrap`):
  - **Top-right**: `PandaStamp` "Read" badge — same component already used, just repositioned onto the cover instead of the card corner.
  - **Top-left**: format badges — new minimal inline SVGs (physical book / ebook / audiobook), one icon per owned format, stacked vertically if more than one. Drawn in the same hand-kept inline-SVG style as `PandaStamp` (no icon library), sized ~16-20px.
- Meta block below the cover, inside the same `TicketCard`: title (`font-display`, truncated to 2 lines), author (1 line, truncated). No format/status text here in grid view — it's now conveyed by the corner badges, per the user's "corner badges + minimal text" answer.
- Whole card links to `/books/[id]` (same full-card-as-link pattern the compact list row already uses), when `bookId` exists.

No-cover fallback keeps today's dashed-border `📖` placeholder tile, just filling the `2/3` box instead of a fixed `h-32 w-24`.

## Grid container

Replaces the `<ul className="space-y-*">` wrapper when view mode is `grid`:

```
<ul class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))">
```

`auto-fill`/`minmax` rather than fixed Tailwind breakpoints (`sm:grid-cols-3` etc.) — matches the reference's approach and self-adjusts to any container width without a breakpoint table to maintain. Implemented via an arbitrary-value Tailwind class or a small scoped style, whichever keeps `page.tsx` closest to its current all-Tailwind style — decided during implementation, not a spec-level concern.

## Where this applies

### `/books`

- Grid is the primary view (default). The existing compact/comfortable list view remains available via the toggle, unchanged in its own behavior (density, jump-to-letter, etc. are unaffected — they're list-view-only concerns already).
- Jump-to-letter nav, search, sort, and filters are unaffected by view mode — they operate above the results list/grid regardless of which is shown.
- `results.map(...)` branches on view mode: `CoverGridCard` in grid, existing `CatalogResultCard` in list.

### `/` (home)

- Same toggle added next to the existing density toggle row. Defaults to list (see above), grid available as an option for consistency.

### `/books/[id]` (detail page)

- Not a listing page, so no grid/toggle here. Instead: the primary displayed cover (currently each copy shows its own `h-32 w-24` cover inside its `TicketCard`) gets a **poster-sized** treatment for visual consistency with the new grid cards — same `2/3`-aspect-ratio box, larger (e.g. `w-40` container instead of `w-24`), with the `PandaStamp` "Read" badge as a corner overlay when the book's `readStatus` is `READ`, rather than as a separate stamp outside the image.
- Only the **first physical copy's cover** (or first ebook cover if no physical copy has one) gets the hero treatment, shown once near the title block; each copy's own card below keeps its existing smaller thumbnail — this page is about one book, not a repeated pattern, so only introducing one hero-sized image avoids visual noise from multiple oversized covers on one page.

### `/books/duplicates`

- Still a list, not a grid — this is a merge-decision UI, not a browse UI, and the reference site has no equivalent of "here are two possibly-identical entries, pick one."
- Each candidate row gains a small `CoverThumbnail` (existing component, `size="compact"`, 48×64) placed beside its text, so visually distinct covers make it obvious at a glance whether two rows are really the same book — this was the concrete gap identified during brainstorming (today's duplicate rows are text-only).

## Non-goals

- No dark theme / palette change — explicitly ruled out by the user ("layout only").
- No voting, genre tags, or comment/description-hover affordances — `family-book-club` concepts with no equivalent data model here.
- No change to search, filter, sort, pagination, or jump-to-letter logic — this spec only changes how results are *displayed*, not what's fetched or how.
- No virtualization of the grid — same reasoning as the existing list ("Load more" plus real filtering is sufficient at this scale; see the density spec's non-goals).
- No client-side view-mode switching library — cookie + server action, matching the density toggle's existing architecture exactly.

## Testing

- `getViewMode`/`setViewMode`: absent cookie yields the per-view default (`grid` for books, `list` for home); a set cookie is honoured; the toggle action writes it and the next render reflects it. Mirrors the existing density cookie tests.
- `CoverGridCard`: renders the placeholder for a null cover; renders the `PandaStamp` badge only when `readStatus === "READ"`; renders one format badge per owned format (physical/ebook/audiobook), and stacks correctly when a book owns more than one; whole card is a link when `bookId` is present, plain (non-link) otherwise — matching `CatalogResultCard`'s existing bookId-optional handling.
- `/books` and `/`: grid view renders `CoverGridCard` per result inside the `auto-fill` grid; list view is pixel-for-pixel unchanged from today (regression check — this spec must not alter existing list behavior).
- `/books/[id]`: hero cover renders only when at least one copy has a cover image; falls back to no hero (existing per-copy thumbnails only) when none do.
- `/books/duplicates`: each candidate row's thumbnail reflects that specific book's cover, not the group's first book's cover — a copy-paste bug risk given the nested map over `group.books`.
- Browser verification at realistic scale, light and dark theme, desktop and 390px: grid reflows correctly at narrow widths via `auto-fill`; toggle switches persist across navigation; corner badges don't overlap when a book has both a read status and multiple formats.
