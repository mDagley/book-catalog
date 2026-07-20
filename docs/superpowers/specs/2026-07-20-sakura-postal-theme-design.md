# Sakura Postal / Library Ticket Theme — Design

## Overview

The app currently uses the unmodified Next.js starter styling — default Geist fonts, `#ffffff`/`#171717` black-on-white, zero custom theming anywhere (`src/app/globals.css` still has the stock `@theme inline` block). This phase replaces it, across the whole app in one pass, with a cohesive "Sakura Postal / Library Ticket" visual identity: a personal library catalog styled like vintage library due-date cards and Japanese stationery, with a panda ink-stamp as the app's recurring signature mark.

This is a from-scratch visual identity, not a tweak — every page and shared component gets the new palette, type, and card language.

## Design tokens

### Color — light mode

| Name | Hex | Role |
|---|---|---|
| Kraft Cream | `#F2E8D5` | Page background |
| Ink | `#332A22` | Body text |
| Sakura | `#D98A96` | Primary accent — buttons, links, active states |
| Panda Black | `#1E1B18` | Near-black — headers, the panda motif, highest-contrast text |
| Bamboo | `#7C8B6F` | Secondary accent — status indicators (e.g. Read/Owned) |
| Perforation | `#C9BCA8` | Dashed card borders and dividers |

### Color — dark mode (a distinct palette, not an inversion)

| Name | Hex | Role |
|---|---|---|
| Night Ink | `#1D1B24` | Page background |
| Card Dusk | `#2A2733` | Card/surface background |
| Moonlit Cream | `#EFE6D8` | Body text |
| Night Sakura | `#E8A2AC` | Primary accent, brightened to read against dark |
| Moss | `#9CAE8A` | Secondary accent |
| Dusk Line | `#4A4658` | Dashed card borders and dividers |

Both modes follow `prefers-color-scheme`, matching the current (unstyled) behavior — no manual toggle in this phase.

### Typography

Three roles, all loaded via `next/font/google` (replacing the current Geist Sans/Mono):

- **Display** — `Fraunces`: titles, page headings, the app masthead. A warm, slightly irregular serif with real personality — used with restraint (headings only, never body copy).
- **Body** — `Karla`: all body text, form labels, buttons, paragraph copy. Humanist, soft, readable at small sizes.
- **Utility/data** — `IBM Plex Mono`: ISBN, dates, publish year, format/status labels, ratings — anything that reads as "stamped data" on a library card. Small caps or uppercase tracking where used for labels.

### Layout language

Content that currently renders as plain bordered `<div>`s (book cards, copy sections, list items) becomes "library ticket" cards:
- Cream (light) / Card Dusk (dark) surface, rounded corners (not sharp — index-card, not spreadsheet-row)
- Dashed `Perforation`/`Dusk Line` border instead of a solid one, evoking a perforated card edge
- A dashed divider (same color) separating a card's title/author block from its metadata block, mirroring the wireframe below
- Metadata (format, status, dates, ISBN) set in the mono utility face, with `Bamboo`/`Moss` used for a positive status word (e.g. "READ") and `Sakura`/`Night Sakura` for an active/current one (e.g. "READING")

```
┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
│ 🐼  The Way of Kings          │  Fraunces + stamp mark
│     Brandon Sanderson         │  Karla, muted
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │  dashed perforation
│ HARDCOVER · READING · ★★★★☆  │  IBM Plex Mono, sakura on status
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
```

Buttons: primary actions get a solid `Sakura`/`Night Sakura` fill with `Kraft Cream`/`Night Ink` text, rounded corners matching the card radius. Secondary/destructive actions (e.g. "Delete") keep an outlined or dashed-border treatment rather than a second solid fill, so the sakura fill stays reserved for the primary action on any given screen.

### Signature element — the panda stamp

A small, hand-drawn SVG mark: a minimal panda face silhouette (two ear circles, two eye-patch ovals, done in 2-3 shapes, no fine detail — reads clearly at 24-40px) rendered as if ink-stamped. Used consistently in exactly three static places (deliberately no transient/animated appearance, per the no-motion non-goal below — most actions in this app redirect immediately on success rather than showing a persistent confirmation screen, so an "on save" flourish wouldn't have anywhere reliable to live):
1. Beside the app name, in a small shared masthead bar. Today only the home page shows "Book Catalog" as a heading — every other page just shows its own page-specific title ("All Books", "TBR — Not Yet Owned", the book's own title, etc.) with no consistent app-level header at all. For the stamp to actually read as a recurring signature rather than a one-off, this phase adds one shared, slim masthead component (app name + stamp icon, nothing else — no new nav links, no new destinations) rendered at the top of every page in Scope, above each page's own existing title/heading. This is additive chrome only: it doesn't change what any page does or how anyone gets to it, so it stays within "visual re-skin," not an IA redesign.
2. As the browser favicon/tab icon, replacing the current default.
3. As a small marker on a book/copy card whose read status is "Read" — a light-touch way of marking completion, not on every card.

This is the one deliberately memorable, repeated element — everything else in the design stays quiet and disciplined around it, per the "spend your boldness in one place" principle.

## Scope

Applies to every existing route and shared component:

**Pages:** `/`, `/login`, `/books`, `/books/new`, `/books/scan`, `/books/duplicates`, `/books/[id]`, `/books/[id]/edit`, `/books/[id]/copies/new`, `/tbr`.

**Shared components:** `CatalogResultCard`, `CatalogFilters`, `CoverThumbnail`, `BookFormFields`, `CopyFormFields`, `ReadingProgressFields`, `SearchAutocomplete`, `RefreshSyncButton`, `CoverEditor`, `CoverPicker`, `CoverCamera`, `BarcodeScanner`, `BurstFramePicker`, `QuadCropEditor`, `EditCopyForm`, `EditEbookCopyCoverForm`, `EditAudiobookCopyCoverForm`.

Given the size of this surface, the implementation plan is expected to front-load the token system and any newly-extracted shared primitives (e.g. a themed card wrapper, a themed button) so that applying the theme to each individual page/component is a smaller, mostly-mechanical step rather than hand-rolling the same styling repeatedly.

## Non-goals

- No manual light/dark toggle — `prefers-color-scheme` only, matching current behavior.
- No redesign of information architecture, page structure, or user flows — this is a visual re-skin of what already exists, not a UX rework. Any layout change is purely in service of the card/perforation language above, not a new feature. The one exception, called out explicitly in the signature-element section above, is a new shared masthead bar (app name + stamp icon) added consistently to every page — additive chrome carrying no new navigation or destinations, not a structural redesign.
- No new illustration beyond the single panda stamp mark — no additional mascot poses, no decorative background patterns, no petal-fall animation or other motion in this phase (motion, if wanted, is a follow-up, not bundled here).
- No changes to functional behavior anywhere (forms, actions, data fetching, camera/scan flows) — purely presentational.
- The camera-heavy components (`BarcodeScanner`, `CoverCamera`, `QuadCropEditor`, `BurstFramePicker`) get the palette/type treatment applied to their surrounding chrome (buttons, labels, overlays) but their core camera-preview/canvas rendering logic is untouched.

## Testing / verification

This app has no automated visual regression or page-rendering tests (established in prior phases this session). Verification is: a real dev-server + Playwright walkthrough covering every route in Scope above, in both light and dark mode (via Playwright's `colorScheme` emulation), confirming the new palette/type/card language renders correctly and no existing functionality broke (forms still submit, camera flows still initiate, etc.) — plus a manual look at both color pairings for adequate text contrast (Ink-on-Cream and Moonlit-Cream-on-Night-Ink should both comfortably clear WCAG AA for body text at the sizes used).
