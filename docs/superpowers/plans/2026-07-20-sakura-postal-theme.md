# Sakura Postal Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the entire app (10 pages, 17 shared components, 4 page-local components) with the "Sakura Postal / Library Ticket" visual identity approved in `docs/superpowers/specs/2026-07-20-sakura-postal-theme-design.md` — one plan, one PR, per explicit user direction.

**Architecture:** Front-load a token system (CSS custom properties + Tailwind v4 `@theme inline`, three `next/font/google` fonts) and three small shared primitives (`PandaStamp`, `Button`, `TicketCard`), then mechanically apply them page by page and component by component. No functional/behavioral changes anywhere — this is purely presentational, so verification is "run the existing test suite after each task" rather than writing new tests for markup/className changes (this repo has an established anti-pattern memory against tests that assert styling with no way to fail meaningfully).

**Tech Stack:** Next.js 16.2.10 (App Router), Tailwind CSS v4 (`@theme inline` token pattern), `next/font/google` (Fraunces, Karla, IBM Plex Mono), React Server + Client Components, Vitest.

**A note on testing for this plan:** every task below is presentational only. Steps do not follow strict red/green TDD (there is no new behavior to drive out), matching this plan's own non-goal: "No changes to functional behavior anywhere." Instead, each task ends by running `npm test` and `npm run build` (or `npx tsc --noEmit` for quick iteration) to confirm nothing broke, plus a note on any *existing* test whose behavior must still hold (e.g. `CopyFormFields.test.tsx`'s id/for assertions). The final task (Task 22) is the one real end-to-end verification pass: a live dev-server + Playwright walkthrough of every route in both color schemes, plus a manual contrast check.

**A note on a deliberate deviation from the spec's literal wording:** the design spec says primary buttons get "a solid Sakura/Night Sakura fill with Kraft Cream/Night Ink text." Translating that literally into hex values shows the **light-mode** pairing (Sakura `#D98A96` fill + Kraft Cream `#F2E8D5` text) measures roughly 2:1 contrast — both colors are pale mid-tones, and it would fail WCAG AA (4.5:1) badly enough to make button labels hard to read. Task 1 below uses Panda Black (`#1E1B18`) as the light-mode button text color instead — kept as the same "on-accent" role name so nothing else in the plan needs to know about the substitution — which clears roughly 6:1. The **dark-mode** pairing (Night Sakura fill + Night Ink text) already clears ~8:1 as literally specified, so it is unchanged. This is flagged here for visibility; the rest of the token table follows the spec exactly.

**A note on a second contrast fix found during implementation (`--link`):** the same 2:1 problem recurs for plain `text-accent underline` inline text links, which every later task in this plan uses pervasively — Sakura text directly on the Kraft Cream page background is just as illegible as Sakura-filled buttons were. This was caught mid-implementation, after Task 10 had already been committed, so a `--link`/`text-link` token (a deepened Sakura, `#9C4258` in light mode, ~5:1; reusing `--accent`'s Night Sakura value in dark mode, where it already clears ~8:1) was added and retrofitted into the already-committed components, then used in place of `text-accent` for every underlined text link in every task from that point on. Task 1's CSS snippet below has been updated to include this token so it matches what actually shipped; `--accent` itself is unchanged, since it's still correct for fills, borders, focus rings, and the active-status color.

---

## File Structure

**New files:**
- `src/components/PandaStamp.tsx` — the reusable signature-element SVG (masthead + card marker)
- `src/app/icon.svg` — static favicon/tab-icon build of the same mark (Next.js app-router icon convention)
- `src/components/Masthead.tsx` — shared app-identity bar, rendered once in the root layout
- `src/components/ui/Button.tsx` — two-variant button primitive (`primary` solid-accent fill, `secondary` dashed-outline), also exports `BUTTON_VARIANT_CLASSES` for the handful of `<Link>` elements styled as buttons
- `src/components/ui/TicketCard.tsx` — the dashed-border "library ticket" card wrapper, plus a `TicketDivider` helper

**Modified files (grouped by task below):** `src/app/globals.css`, `src/app/layout.tsx`, `src/app/favicon.ico` (deleted), and every page/component listed in the design spec's Scope section.

**Deleted files:** `src/app/favicon.ico` (replaced by `src/app/icon.svg`).

---

### Task 1: Design tokens and fonts

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Replace the token system in `globals.css`**

Replace the entire contents of `src/app/globals.css` with:

```css
@import "tailwindcss";

:root {
  /* Sakura Postal / Library Ticket — light mode.
     See docs/superpowers/specs/2026-07-20-sakura-postal-theme-design.md */
  --background: #F2E8D5; /* Kraft Cream */
  --surface: #F2E8D5; /* Kraft Cream — cards sit on the same cream as the
     page, distinguished only by their dashed border, not a fill change */
  --foreground: #332A22; /* Ink */
  --foreground-strong: #1E1B18; /* Panda Black */
  --accent: #D98A96; /* Sakura */
  /* The spec calls for Kraft Cream text on a solid Sakura fill, but Sakura
     and Kraft Cream are both pale mid-tones -- that pairing measures ~2:1
     contrast, well under WCAG AA's 4.5:1. Panda Black on Sakura clears
     ~6:1, so button text uses that instead; every other light-mode role
     below keeps its spec value as written. */
  --accent-foreground: #1E1B18;
  --status-positive: #7C8B6F; /* Bamboo */
  --status-active: #D98A96; /* Sakura */
  --perforation: #C9BCA8; /* Perforation */
  /* Same contrast problem as --accent-foreground above, hitting a
     different role: plain "text-accent underline" inline text links put
     Sakura text directly on the Kraft Cream page background, which also
     measures ~2:1. A deepened rose (still recognizably the same hue
     family) clears ~5:1. --accent itself is untouched (still used for
     solid fills, borders, focus rings, and the active-status color),
     since none of those pairings were flagged as failing. This token and
     its Tailwind mapping were added mid-implementation, after this
     snippet was first written -- see the "fix: add --link token" commit. */
  --link: #9C4258; /* Sakura Ink -- a deepened Sakura for link text only */
}

@theme inline {
  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-foreground: var(--foreground);
  --color-foreground-strong: var(--foreground-strong);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-status-positive: var(--status-positive);
  --color-status-active: var(--status-active);
  --color-perforation: var(--perforation);
  --color-link: var(--link);
  --font-sans: var(--font-karla);
  --font-display: var(--font-fraunces);
  --font-mono: var(--font-ibm-plex-mono);
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Sakura Postal / Library Ticket — dark mode. A distinct palette, not
       an inversion, per the design spec. */
    --background: #1D1B24; /* Night Ink */
    --surface: #2A2733; /* Card Dusk */
    --foreground: #EFE6D8; /* Moonlit Cream */
    /* Dark backgrounds have no "near-black" that would read as
       highest-contrast, so this role collapses onto the same Moonlit
       Cream already used for body text. */
    --foreground-strong: #EFE6D8;
    --accent: #E8A2AC; /* Night Sakura */
    --accent-foreground: #1D1B24; /* Night Ink — already clears WCAG AA
       against Night Sakura as literally specified */
    --status-positive: #9CAE8A; /* Moss */
    --status-active: #E8A2AC; /* Night Sakura */
    --perforation: #4A4658; /* Dusk Line */
    /* Night Sakura on Night Ink already clears ~8:1, so link text reuses
       --accent directly rather than needing its own darker value. */
    --link: #E8A2AC; /* Night Sakura */
  }
}

body {
  background: var(--background);
  color: var(--foreground);
}
```

This drops the old `font-family: Arial, Helvetica, sans-serif;` rule (Step 2 wires Karla in as `--font-sans` via `layout.tsx`'s `font-sans` utility class on `<body>`, which takes precedence over any element-selector rule anyway) and the old `--color-background`/`--color-foreground` mapped straight to raw hex — every color is now a named CSS variable first, mapped into Tailwind's theme second, exactly matching the existing file's own light/dark-via-`@media` structure, just with more roles.

- [ ] **Step 2: Load the three fonts and fix `metadata` in `layout.tsx`**

Replace the entire contents of `src/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Fraunces, Karla, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

const karla = Karla({
  variable: "--font-karla",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Book Catalog",
  description: "A personal library catalog for physical books, ebooks, and audiobooks.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${karla.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background font-sans text-foreground">
        {children}
      </body>
    </html>
  );
}
```

(Task 3 below adds the `<Masthead />` import and render here — this step deliberately leaves it out so the font/token wiring and the masthead are separate, reviewable commits.)

`IBM_Plex_Mono` requires an explicit `weight` array (it isn't a variable font, unlike Fraunces and Karla, which don't need one) — confirmed against this project's installed `next/dist/compiled/@next/font/dist/google/font-data.json`, since AGENTS.md warns this Next.js version can differ from training data.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS, no TypeScript errors, all existing tests still pass (nothing in this step touches component logic).

Start the dev server (`npm run dev`, falls back to port 3001 in this environment) and open `http://localhost:3001/` — confirm the page loads with the new Kraft Cream background and Ink-colored text, and that the browser tab still shows the old default favicon (Task 2 replaces it).

- [ ] **Step 4: Commit**

```bash
git add src/app/globals.css src/app/layout.tsx
git commit -m "feat: add Sakura Postal design tokens and fonts"
```

---

### Task 2: Signature element — the panda stamp

**Files:**
- Create: `src/components/PandaStamp.tsx`
- Create: `src/app/icon.svg`
- Delete: `src/app/favicon.ico`

- [ ] **Step 1: Create the reusable `PandaStamp` component**

Create `src/components/PandaStamp.tsx`:

```tsx
interface PandaStampProps {
  className?: string;
  title?: string;
}

// The app's one signature illustration (see the design spec's
// signature-element section): a minimal ink-stamp panda mark built from
// just three shape types -- a stamp-ring circle, two ear circles, two eye
// ovals -- so it stays legible at the 20-40px sizes it's actually used at
// (the masthead, and a small "Read" marker on cards). `src/app/icon.svg`
// is a hand-kept static copy of the same shapes for the browser favicon,
// since a standalone icon file can't use `currentColor`.
export function PandaStamp({ className, title }: PandaStampProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <circle cx="16" cy="17" r="13" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="4.5" fill="currentColor" />
      <circle cx="25" cy="7" r="4.5" fill="currentColor" />
      <ellipse cx="11" cy="17" rx="3" ry="4.5" fill="currentColor" />
      <ellipse cx="21" cy="17" rx="3" ry="4.5" fill="currentColor" />
    </svg>
  );
}
```

- [ ] **Step 2: Add the static favicon**

Create `src/app/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="17" r="13" fill="none" stroke="#1E1B18" stroke-width="1.5" />
  <circle cx="7" cy="7" r="4.5" fill="#1E1B18" />
  <circle cx="25" cy="7" r="4.5" fill="#1E1B18" />
  <ellipse cx="11" cy="17" rx="3" ry="4.5" fill="#1E1B18" />
  <ellipse cx="21" cy="17" rx="3" ry="4.5" fill="#1E1B18" />
</svg>
```

Colors are hardcoded to Panda Black (`#1E1B18`) rather than `currentColor` — a standalone favicon file has no CSS context to inherit a color from, so it can't respond to the app's own dark-mode media query anyway (browser tab chrome theming is outside this app's control).

Per `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md` (checked per AGENTS.md's instruction to verify Next.js conventions against this version's own docs, not training data): `.svg` is a directly-supported static `icon` file type in `app/**/*`, no code-generation needed — placing `src/app/icon.svg` is sufficient for Next.js to wire up the `<link rel="icon">` tag automatically.

- [ ] **Step 3: Remove the old default favicon**

```bash
git rm src/app/favicon.ico
```

- [ ] **Step 4: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

With the dev server running, reload `http://localhost:3001/` and confirm the browser tab now shows the panda stamp icon instead of the old default.

- [ ] **Step 5: Commit**

```bash
git add src/components/PandaStamp.tsx src/app/icon.svg
git commit -m "feat: add panda stamp signature element and favicon"
```

---

### Task 3: Shared masthead

**Files:**
- Create: `src/components/Masthead.tsx`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Create the `Masthead` component**

Create `src/components/Masthead.tsx`:

```tsx
import { PandaStamp } from "@/components/PandaStamp";

// Slim shared app-identity bar rendered once, above every page's own
// heading (see layout.tsx). Deliberately carries no nav links of its own
// -- every page keeps its existing links/back-buttons exactly as before.
// This is the one explicit exception to "no IA redesign" called out in the
// design spec: additive chrome only, giving the panda stamp a consistent
// home since no page previously had an app-level header at all.
export function Masthead() {
  return (
    <div className="border-b border-dashed border-perforation px-4 py-2">
      <div className="mx-auto flex max-w-2xl items-center gap-2">
        <PandaStamp className="h-5 w-5 text-foreground-strong" />
        <span className="font-display text-sm font-semibold tracking-wide text-foreground-strong">
          Book Catalog
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the root layout**

In `src/app/layout.tsx`, add the import and render `<Masthead />` as the first child of `<body>`:

```tsx
import type { Metadata } from "next";
import { Fraunces, Karla, IBM_Plex_Mono } from "next/font/google";
import { Masthead } from "@/components/Masthead";
import "./globals.css";
```

and:

```tsx
      <body className="min-h-full flex flex-col bg-background font-sans text-foreground">
        <Masthead />
        {children}
      </body>
```

Note: the home page (`src/app/page.tsx`, themed in Task 13) keeps its own `<h1>Book Catalog</h1>` heading unchanged — the design spec's ambiguity-resolution explicitly says the masthead renders "above each page's own **existing** title," not in place of it, so the home page will show the name twice (masthead + its own heading). This was a deliberate, already-approved call made during brainstorming, not an oversight here.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

With the dev server running, reload a few different routes (`/`, `/books`, `/tbr`) and confirm the same slim masthead bar with the panda stamp and "Book Catalog" appears above each page's own content, and that it does not duplicate itself or interfere with `/login`'s centered layout.

- [ ] **Step 4: Commit**

```bash
git add src/components/Masthead.tsx src/app/layout.tsx
git commit -m "feat: add shared masthead with panda stamp to every page"
```

---

### Task 4: Shared UI primitives — Button and TicketCard

**Files:**
- Create: `src/components/ui/Button.tsx`
- Create: `src/components/ui/TicketCard.tsx`

- [ ] **Step 1: Create the `Button` primitive**

Create `src/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// The app's two button treatments (see the design spec's layout-language
// section): a solid accent fill reserved for the one primary action per
// screen, and an outlined dashed-border treatment for everything else --
// secondary actions AND destructive ones like Delete. There's no third
// "destructive" variant: the design spec doesn't define a danger color, so
// Delete-style actions use `secondary` like any other non-primary action.
// Exported separately from the component (not just used internally) so the
// few places that render a `<Link>` styled as a button -- which this
// component can't do, since it only ever renders a real <button> -- can
// reuse the exact same class strings instead of hand-copying them.
export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground",
  secondary: "border border-dashed border-perforation bg-transparent text-foreground",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${BUTTON_VARIANT_CLASSES[variant]} ${className}`}
    />
  );
}
```

Every call site in later tasks only appends non-conflicting layout classes (`w-full`, `flex-1`, `mt-1`) via `className` — never a class that would collide with something `BUTTON_VARIANT_CLASSES`/the base string already sets (e.g. never re-declaring padding or text size), since two same-specificity Tailwind utility classes for the same property don't reliably resolve in className string order.

- [ ] **Step 2: Create the `TicketCard` primitive**

Create `src/components/ui/TicketCard.tsx`:

```tsx
import type { HTMLAttributes } from "react";

interface TicketCardProps extends HTMLAttributes<HTMLElement> {
  as?: "li" | "div";
}

// The "library ticket" card treatment used for book/copy listings (see the
// design spec's layout-language section and wireframe): a surface matching
// the page background in light mode, a distinct Card Dusk surface in dark
// mode, and a dashed border evoking a perforated card edge. Renders as an
// <li> by default since every current caller sits inside a <ul>/<ol>; pass
// `as="div"` for call sites that don't (e.g. the edit page's per-section
// blocks). Deliberately carries no padding of its own -- every caller
// supplies it via `className` (e.g. `className="p-3"`), so there's no risk
// of a caller's padding override silently losing to this component's own.
export function TicketCard({ as = "li", className = "", children, ...props }: TicketCardProps) {
  const Tag = as;
  return (
    <Tag
      {...props}
      className={`rounded-xl border border-dashed border-perforation bg-surface ${className}`}
    >
      {children}
    </Tag>
  );
}

// The dashed divider separating a card's title/author block from its
// metadata block, per the wireframe in the design spec.
export function TicketDivider() {
  return <hr className="my-2 border-t border-dashed border-perforation" />;
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. (Neither component is wired into anything yet, so this just confirms they compile.)

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/Button.tsx src/components/ui/TicketCard.tsx
git commit -m "feat: add themed Button and TicketCard primitives"
```

---

### Task 5: CatalogResultCard and CoverThumbnail

**Files:**
- Modify: `src/components/CatalogResultCard.tsx`
- Modify: `src/components/CoverThumbnail.tsx`

- [ ] **Step 1: Theme `CoverThumbnail`**

Replace `src/components/CoverThumbnail.tsx`:

```tsx
export function CoverThumbnail({ coverImagePath }: { coverImagePath: string | null }) {
  if (!coverImagePath) {
    return (
      <div
        className="mb-2 flex h-32 w-24 items-center justify-center rounded border border-dashed border-perforation bg-surface text-3xl text-foreground/40"
        aria-hidden="true"
      >
        📖
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/covers/${encodeURIComponent(coverImagePath)}`}
      alt="Cover"
      className="mb-2 h-32 w-24 rounded object-cover"
    />
  );
}
```

- [ ] **Step 2: Theme `CatalogResultCard`, including the "Read" panda-stamp marker**

Replace `src/components/CatalogResultCard.tsx`:

```tsx
import Link from "next/link";
import type { SearchResult } from "@/lib/search";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { READ_STATUS_LABELS, ratingStars } from "@/components/ReadingProgressFields";
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { PandaStamp } from "@/components/PandaStamp";
import { TicketCard, TicketDivider } from "@/components/ui/TicketCard";

const STATUS_CLASS: Record<string, string> = {
  READ: "text-status-positive",
  READING: "text-status-active",
  TO_READ: "text-foreground/70",
};

interface MetaPart {
  key: string;
  label: string;
  className?: string;
  ariaLabel?: string;
}

// One catalog entry as rendered in a search/browse result list -- shared
// between the home page's unified search and /books' "All Books" browse
// view, both of which render searchCatalog() results identically.
export function CatalogResultCard({ result }: { result: SearchResult }) {
  const metaParts: MetaPart[] = [
    ...result.physicalCopies.map((copy) => ({
      key: `physical-${copy.id}`,
      label: `${FORMAT_LABELS[copy.format]}${copy.publisher ? `, ${copy.publisher}` : ""}${copy.publishYear ? ` ${copy.publishYear}` : ""}`,
    })),
    ...(result.hasEbook ? [{ key: "ebook", label: "Ebook" }] : []),
    ...(result.hasAudiobook ? [{ key: "audiobook", label: "Audiobook" }] : []),
    ...(result.readStatus
      ? [
          {
            key: "status",
            label: READ_STATUS_LABELS[result.readStatus],
            className: STATUS_CLASS[result.readStatus],
          },
        ]
      : []),
    ...(result.rating !== null
      ? [
          {
            key: "rating",
            label: ratingStars(result.rating),
            ariaLabel: `Rated ${result.rating} out of 5`,
          },
        ]
      : []),
  ];

  return (
    <TicketCard className="relative p-3">
      {result.readStatus === "READ" && (
        <PandaStamp title="Read" className="absolute right-3 top-3 h-5 w-5 text-status-positive" />
      )}
      <CoverThumbnail coverImagePath={result.coverImagePath} />
      <p className="font-display font-semibold text-foreground-strong">{result.title}</p>
      {result.author && <p className="text-sm text-foreground/70">{result.author}</p>}
      {metaParts.length > 0 && (
        <>
          <TicketDivider />
          <p className="flex flex-wrap items-center font-mono text-xs uppercase tracking-wide text-foreground/70">
            {metaParts.map((part, index) => (
              <span key={part.key} className={part.className} aria-label={part.ariaLabel}>
                {index > 0 && <span className="mx-1 text-foreground/40">·</span>}
                {part.label}
              </span>
            ))}
          </p>
        </>
      )}
      {result.bookId && (
        <Link href={`/books/${result.bookId}`} className="mt-2 inline-block text-sm text-accent underline">
          View details
        </Link>
      )}
    </TicketCard>
  );
}
```

This replaces the previous `rounded bg-gray-100 px-2 py-0.5` metadata pills with the spec's wireframe treatment: a single mono-face, dot-separated line (`HARDCOVER · READING · ★★★★☆`), with status words colored via `STATUS_CLASS`. A "Read" result also gets the panda stamp as a small corner marker, per the design spec's third signature-element placement.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. Then start the dev server and check `/` and `/books` render result cards with covers, the dot-separated metadata line, and (for any book with `readStatus: "READ"`) the small panda marker in the card's corner.

- [ ] **Step 4: Commit**

```bash
git add src/components/CatalogResultCard.tsx src/components/CoverThumbnail.tsx
git commit -m "feat: theme CatalogResultCard and CoverThumbnail"
```

---

### Task 6: CatalogFilters

**Files:**
- Modify: `src/components/CatalogFilters.tsx`

- [ ] **Step 1: Theme the filter row**

Replace `src/components/CatalogFilters.tsx`:

```tsx
import { FORMAT_OPTIONS } from "@/components/CopyFormFields";
import { STATUS_FILTER_OPTIONS } from "@/components/ReadingProgressFields";
import type { OwnershipType, ReadStatusFilterValue, StatusFilterMode } from "@/lib/search";
import type { Format } from "@prisma/client";
import { Button } from "@/components/ui/Button";

export const OWNERSHIP_TYPE_OPTIONS: { value: OwnershipType; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "ebook", label: "Ebook" },
  { value: "audiobook", label: "Audiobook" },
];

interface CatalogFiltersProps {
  types?: OwnershipType[];
  status?: ReadStatusFilterValue[];
  statusMode: StatusFilterMode;
  format?: Format;
}

// The ownership-type/status/format filter row shared between the home
// page's unified search and /books' "All Books" browse view. Rendered
// inside each page's own <form>, alongside that page's own
// SearchAutocomplete (which has a different `scope` per page, so it stays
// outside this shared component).
export function CatalogFilters({ types, status, statusMode, format }: CatalogFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-foreground">
      {OWNERSHIP_TYPE_OPTIONS.map((opt) => (
        <label key={opt.value} className="flex items-center gap-1">
          <input
            type="checkbox"
            name="types"
            value={opt.value}
            defaultChecked={types?.includes(opt.value) ?? false}
            className="accent-accent"
          />
          {opt.label}
        </label>
      ))}
      {STATUS_FILTER_OPTIONS.map((opt) => (
        <label key={opt.value} className="flex items-center gap-1">
          <input
            type="checkbox"
            name="status"
            value={opt.value}
            defaultChecked={status?.includes(opt.value) ?? false}
            className="accent-accent"
          />
          {opt.label}
        </label>
      ))}
      <span className="flex items-center gap-1 text-foreground/70">
        Match:
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="statusMode"
            value="or"
            defaultChecked={statusMode === "or"}
            className="accent-accent"
          />
          Any
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name="statusMode"
            value="and"
            defaultChecked={statusMode === "and"}
            className="accent-accent"
          />
          All
        </label>
      </span>
      <select
        name="format"
        defaultValue={format ?? ""}
        className="rounded-lg border border-perforation bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        aria-label="Filter by physical format"
      >
        <option value="">Any format</option>
        {FORMAT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <Button type="submit">Search</Button>
    </div>
  );
}
```

`accent-accent` uses Tailwind v4's automatic `accent-color` utility generation from the registered `--color-accent` theme token, tinting native checkboxes/radios to match the palette without any custom control styling.

- [ ] **Step 2: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. Then check `/` and `/books` in the dev server — filters and the Search button should render themed, and submitting the form should still filter results exactly as before.

- [ ] **Step 3: Commit**

```bash
git add src/components/CatalogFilters.tsx
git commit -m "feat: theme CatalogFilters"
```

---

### Task 7: SearchAutocomplete

**Files:**
- Modify: `src/components/SearchAutocomplete.tsx`

- [ ] **Step 1: Theme the input and dropdown**

In `src/components/SearchAutocomplete.tsx`, replace only the returned JSX (all state/effects/handlers above it are unchanged):

```tsx
  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        name={name}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (next.trim().length < MIN_QUERY_LENGTH) {
            setSuggestions([]);
            setIsOpen(false);
          }
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsOpen(suggestions.length > 0)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
      {isOpen && (
        <ul className="absolute z-10 mt-1 w-full rounded-lg border border-perforation bg-surface shadow-lg">
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.title}-${suggestion.author ?? ""}-${index}`}>
              <button
                type="button"
                onClick={() => selectSuggestion(suggestion)}
                className={`block w-full px-3 py-2 text-left text-sm text-foreground ${
                  index === highlightedIndex ? "bg-accent/15" : ""
                }`}
              >
                <span className="font-medium">{suggestion.title}</span>
                {suggestion.author && (
                  <span className="ml-1 text-foreground/70">— {suggestion.author}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, type into the home page's search box and confirm the dropdown still opens, highlights on arrow keys, and selecting a suggestion still submits the form (unchanged behavior — only colors/borders changed).

- [ ] **Step 3: Commit**

```bash
git add src/components/SearchAutocomplete.tsx
git commit -m "feat: theme SearchAutocomplete"
```

---

### Task 8: RefreshSyncButton

**Files:**
- Modify: `src/components/RefreshSyncButton.tsx`

- [ ] **Step 1: Swap the raw button for the `Button` primitive**

In `src/components/RefreshSyncButton.tsx`, add the import:

```tsx
import { Button } from "@/components/ui/Button";
```

and replace the returned JSX's button:

```tsx
  return (
    <div>
      <Button type="button" variant="secondary" onClick={handleRefresh} disabled={isRefreshing}>
        {isRefreshing ? "Refreshing..." : "Refresh now"}
      </Button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, click "Refresh now" on the home page and confirm it still triggers the sequential ABS/Goodreads sync exactly as before.

- [ ] **Step 3: Commit**

```bash
git add src/components/RefreshSyncButton.tsx
git commit -m "feat: theme RefreshSyncButton"
```

---

### Task 9: BookFormFields and CopyFormFields

**Files:**
- Modify: `src/components/BookFormFields.tsx`
- Modify: `src/components/CopyFormFields.tsx`
- Note: `src/components/ReadingProgressFields.tsx` is in the design spec's Scope list but exports only constants and the `ratingStars` helper — no JSX. It needs no change in this task; its exported labels/options are consumed by already- or later-themed callers (`CatalogResultCard`, the edit page).

- [ ] **Step 1: Theme `BookFormFields`**

Replace `src/components/BookFormFields.tsx`:

```tsx
interface BookFormFieldsProps {
  defaultTitle?: string;
  defaultAuthor?: string;
  defaultIsbn?: string;
}

export function BookFormFields({
  defaultTitle = "",
  defaultAuthor = "",
  defaultIsbn = "",
}: BookFormFieldsProps) {
  const fieldClass =
    "mt-1 w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <>
      <div>
        <label htmlFor="title" className="block text-sm font-medium text-foreground">
          Title
        </label>
        <input id="title" name="title" required defaultValue={defaultTitle} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="author" className="block text-sm font-medium text-foreground">
          Author
        </label>
        <input id="author" name="author" defaultValue={defaultAuthor} className={fieldClass} />
      </div>
      <div>
        <label htmlFor="isbn" className="block text-sm font-medium text-foreground">
          ISBN
        </label>
        <input
          id="isbn"
          name="isbn"
          defaultValue={defaultIsbn}
          className={`${fieldClass} font-mono`}
        />
      </div>
    </>
  );
}
```

- [ ] **Step 2: Theme `CopyFormFields`**

Replace `src/components/CopyFormFields.tsx`:

```tsx
export const FORMAT_OPTIONS = [
  { value: "HARDCOVER", label: "Hardcover" },
  { value: "PAPERBACK", label: "Paperback" },
  { value: "MASS_MARKET", label: "Mass Market" },
  { value: "OTHER", label: "Other" },
] as const;

export const FORMAT_LABELS: Record<string, string> = Object.fromEntries(
  FORMAT_OPTIONS.map((opt) => [opt.value, opt.label]),
);

interface CopyFormFieldsProps {
  defaultFormat?: string;
  defaultPublisher?: string;
  defaultPublishYear?: string;
  defaultSpecialNotes?: string;
  // Distinguishes this instance's field ids from any other CopyFormFields
  // rendered on the same page (e.g. one section per physical copy on the
  // consolidated book edit page) -- without it, every instance would emit
  // the same id="format" etc., which is invalid HTML and breaks label
  // association for every instance after the first. Empty by default so
  // the single-instance callers (AddCopyForm) keep their existing ids
  // unchanged.
  idPrefix?: string;
}

export function CopyFormFields({
  defaultFormat = "",
  defaultPublisher = "",
  defaultPublishYear = "",
  defaultSpecialNotes = "",
  idPrefix = "",
}: CopyFormFieldsProps) {
  const fieldId = (name: string) => (idPrefix ? `${idPrefix}-${name}` : name);
  const fieldClass =
    "mt-1 w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <>
      <div>
        <label htmlFor={fieldId("format")} className="block text-sm font-medium text-foreground">
          Format
        </label>
        <select
          id={fieldId("format")}
          name="format"
          required
          defaultValue={defaultFormat}
          className={fieldClass}
        >
          <option value="">Select a format</option>
          {FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={fieldId("publisher")} className="block text-sm font-medium text-foreground">
          Publisher
        </label>
        <input id={fieldId("publisher")} name="publisher" defaultValue={defaultPublisher} className={fieldClass} />
      </div>
      <div>
        <label htmlFor={fieldId("publishYear")} className="block text-sm font-medium text-foreground">
          Publish Year
        </label>
        <input
          id={fieldId("publishYear")}
          name="publishYear"
          type="number"
          defaultValue={defaultPublishYear}
          className={`${fieldClass} font-mono`}
        />
      </div>
      <div>
        <label htmlFor={fieldId("specialNotes")} className="block text-sm font-medium text-foreground">
          Special Notes
        </label>
        <textarea
          id={fieldId("specialNotes")}
          name="specialNotes"
          defaultValue={defaultSpecialNotes}
          className={fieldClass}
        />
      </div>
    </>
  );
}
```

The `fieldId()` id-prefixing logic is untouched, so `src/components/CopyFormFields.test.tsx` (which asserts exact `id="format"`/`id="copy-a-format"`-style strings, not classNames) keeps passing unmodified.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test -- CopyFormFields`
Expected: PASS, including the existing `CopyFormFields.test.tsx` suite unchanged.

Then run the full suite: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/BookFormFields.tsx src/components/CopyFormFields.tsx
git commit -m "feat: theme BookFormFields and CopyFormFields"
```

---

### Task 10: CoverEditor and CoverPicker

**Files:**
- Modify: `src/components/CoverEditor.tsx`
- Modify: `src/components/CoverPicker.tsx`

- [ ] **Step 1: Theme `CoverEditor`**

In `src/components/CoverEditor.tsx`, replace the returned JSX (all state/handlers above it are unchanged):

```tsx
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Cover Image</p>
      {previewSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewSrc} alt="Cover" className="mb-2 h-32 w-24 rounded object-cover" />
      ) : (
        <p className="mb-2 text-sm text-foreground/70">No cover set.</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer text-sm text-accent underline">
          Upload a file
          <input
            type="file"
            accept={ACCEPTED_COVER_TYPES.join(",")}
            onChange={handleFileChange}
            className="sr-only"
          />
        </label>
        {bookIsbn && (
          <button
            type="button"
            onClick={handleLookup}
            disabled={isLookingUp}
            className="text-sm text-accent underline disabled:opacity-50"
          >
            {isLookingUp ? "Looking up..." : "Use Open Library cover"}
          </button>
        )}
        {allowCamera && (
          <button type="button" onClick={() => setShowCamera(true)} className="text-sm text-accent underline">
            Take a photo
          </button>
        )}
      </div>
      {lookupError && <p className="mt-1 text-sm text-red-600">{lookupError}</p>}
      {allowCamera && showCamera && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Take a cover photo"
          className="fixed inset-0 z-10 overflow-y-auto bg-background p-4"
        >
          <CoverCamera
            onCapture={(dataUrl) => {
              setLookupError(null);
              setSelectedDataUrl(dataUrl);
              setSelectedSource("dataUrl");
              setShowCamera(false);
            }}
            onSkip={() => setShowCamera(false)}
          />
        </div>
      )}
      <input type="hidden" name="selectedCoverDataUrl" value={selectedDataUrl ?? ""} />
      <input type="hidden" name="selectedCoverSource" value={selectedSource ?? ""} />
    </div>
  );
}
```

- [ ] **Step 2: Theme `CoverPicker`**

In `src/components/CoverPicker.tsx`, replace the returned JSX (all state/effects above it are unchanged):

```tsx
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Cover Image</p>
      {!capturedImageDataUrl && !openLibraryCoverUrl && (
        <p className="text-sm text-foreground/70">No cover selected yet.</p>
      )}
      <div className="flex gap-3">
        {capturedImageDataUrl && (
          <button
            type="button"
            onClick={() => setSelected("captured")}
            aria-pressed={selected === "captured"}
            className={`rounded-lg border-2 p-1 ${selected === "captured" ? "border-accent" : "border-transparent"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={capturedImageDataUrl} alt="Your photo" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs text-foreground/70">Your photo</p>
          </button>
        )}
        {openLibraryCoverUrl && (
          <button
            type="button"
            onClick={() => setSelected("openLibrary")}
            aria-pressed={selected === "openLibrary"}
            className={`rounded-lg border-2 p-1 ${selected === "openLibrary" ? "border-accent" : "border-transparent"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={openLibraryCoverUrl} alt="Open Library cover" className="h-32 w-24 object-cover" />
            <p className="text-center text-xs text-foreground/70">Open Library</p>
          </button>
        )}
      </div>
      {onRetake && (
        <button type="button" onClick={onRetake} className="mt-2 text-sm text-accent underline">
          {capturedImageDataUrl ? "Retake photo" : "Add a photo"}
        </button>
      )}
      <input type="hidden" name="selectedCoverDataUrl" value={selectedDataUrl ?? ""} />
      <input
        type="hidden"
        name="selectedCoverSource"
        value={selected === "openLibrary" ? "url" : "dataUrl"}
      />
    </div>
  );
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/CoverEditor.tsx src/components/CoverPicker.tsx
git commit -m "feat: theme CoverEditor and CoverPicker"
```

---

### Task 11: Camera-heavy components (chrome only)

**Files:**
- Modify: `src/components/CoverCamera.tsx`
- Modify: `src/components/BurstFramePicker.tsx`
- Modify: `src/components/QuadCropEditor.tsx`
- No change: `src/components/BarcodeScanner.tsx` (its only chrome is an error message, which intentionally keeps the default red — see Task 1's contrast note; there is nothing else to theme, since the rest is a bare `<video>` element)

Per the design spec's non-goal: these four components get their surrounding chrome (buttons, labels, overlays) themed, but their core camera-preview/canvas/SVG-crop rendering logic is untouched. `QuadCropEditor`'s crop-overlay SVG (white/black drag handles and dimming polygon over an arbitrary captured photo) and the live `<video>`/`<canvas>` elements in all four components count as that core logic, not decorative chrome, so their colors stay as literal white/black — that's a functional high-contrast requirement against unpredictable photo/video content, not a themeable surface.

- [ ] **Step 1: Theme `CoverCamera`'s chrome**

In `src/components/CoverCamera.tsx`, add the import:

```tsx
import { Button } from "@/components/ui/Button";
```

and replace the final returned JSX block (the `step.kind === "preview"` case; the `picking`/`cropping` early returns above it are unchanged):

```tsx
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Take a photo of the cover</p>
      {error && (
        <p className="text-sm text-red-600">
          Camera error: {error}.{onSkip && " You can still skip this step."}
        </p>
      )}
      <div className="relative">
        <video
          ref={videoRef}
          className="w-full rounded"
          muted
          playsInline
          autoPlay
          onLoadedMetadata={() => setIsReady(true)}
        />
        {torchSupported && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            className={`absolute right-2 top-2 rounded px-2 py-1 text-xs ${
              torchOn ? "bg-yellow-400 text-black" : "bg-foreground-strong/70 text-background"
            }`}
          >
            {torchOn ? "Flash on" : "Flash off"}
          </button>
        )}
      </div>
      <div className="mt-2 flex gap-3">
        <Button
          type="button"
          onClick={handleTakePhoto}
          disabled={!!error || !isReady || isCapturingBurst}
          className="flex-1"
        >
          {isCapturingBurst ? "Capturing..." : "Take Photo"}
        </Button>
        {onSkip && (
          <Button type="button" onClick={onSkip} variant="secondary" className="flex-1">
            Skip
          </Button>
        )}
      </div>
    </div>
  );
}
```

The torch button's "on" state (`bg-yellow-400 text-black`) is left as a literal, unthemed amber — it's a hardware-status indicator (flash is physically on), not a themed UI surface, so it keeps maximum, unambiguous contrast. Only its "off" state swaps the previous literal `bg-black/60 text-white` for the equivalent theme tokens (`bg-foreground-strong/70 text-background`), which resolve to the same near-black/near-white pairing in light mode and stay legible in dark mode too.

- [ ] **Step 2: Theme `BurstFramePicker`**

Replace `src/components/BurstFramePicker.tsx`:

```tsx
// src/components/BurstFramePicker.tsx
"use client";

interface BurstFramePickerProps {
  shots: string[];
  onPick: (shot: string) => void;
  onRetake: () => void;
}

export function BurstFramePicker({ shots, onPick, onRetake }: BurstFramePickerProps) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Pick the clearest shot</p>
      <div className="flex gap-2 overflow-x-auto">
        {shots.map((shot, index) => (
          <button
            key={index}
            type="button"
            onClick={() => onPick(shot)}
            className="shrink-0 rounded border-2 border-transparent p-0.5 hover:border-accent"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shot} alt={`Shot ${index + 1}`} className="h-32 w-24 rounded object-cover" />
          </button>
        ))}
      </div>
      <button type="button" onClick={onRetake} className="mt-2 text-sm text-accent underline">
        Retake
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Theme `QuadCropEditor`'s chrome**

In `src/components/QuadCropEditor.tsx`, add the import:

```tsx
import { Button } from "@/components/ui/Button";
```

and replace the final returned JSX block (the `<img>`/crop-overlay `<svg>` block inside it is unchanged — only the caption paragraph and the two action buttons below it change):

```tsx
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-foreground">Drag the corners to match the cover&apos;s edges</p>
      <div ref={containerRef} className="relative inline-block max-w-full touch-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={imageDataUrl}
          alt="Captured cover"
          className="block max-w-full rounded"
          onLoad={handleImageLoad}
        />
        {corners && displaySize && (
          <svg
            className="absolute inset-0"
            width={displaySize.width}
            height={displaySize.height}
            viewBox={`0 0 ${displaySize.width} ${displaySize.height}`}
          >
            <path
              d={
                `M0,0 H${displaySize.width} V${displaySize.height} H0 Z ` +
                `M${corners.topLeft.x},${corners.topLeft.y} ` +
                `L${corners.topRight.x},${corners.topRight.y} ` +
                `L${corners.bottomRight.x},${corners.bottomRight.y} ` +
                `L${corners.bottomLeft.x},${corners.bottomLeft.y} Z`
              }
              fillRule="evenodd"
              fill="rgba(0,0,0,0.5)"
            />
            <polygon
              points={CORNER_ORDER.map((name) => `${corners[name].x},${corners[name].y}`).join(" ")}
              fill="none"
              stroke="white"
              strokeWidth={2}
            />
            {CORNER_ORDER.map((name) => (
              <g key={name}>
                <circle
                  cx={corners[name].x}
                  cy={corners[name].y}
                  r={22}
                  fill="transparent"
                  style={{ pointerEvents: "auto", touchAction: "none", cursor: "move" }}
                  onPointerDown={() => {
                    draggingCorner.current = name;
                  }}
                />
                <circle
                  cx={corners[name].x}
                  cy={corners[name].y}
                  r={12}
                  fill="white"
                  stroke="black"
                  strokeWidth={2}
                  style={{ pointerEvents: "none" }}
                />
              </g>
            ))}
          </svg>
        )}
      </div>
      <div className="mt-2 flex gap-3">
        <Button type="button" onClick={handleConfirm} disabled={isProcessing || !corners} className="flex-1">
          {isProcessing ? "Processing..." : "Use this photo"}
        </Button>
        <Button type="button" onClick={onRetake} variant="secondary" className="flex-1">
          Retake
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

`src/lib/perspectiveCrop.test.ts` covers the actual warp/crop math and is untouched by this task, so it should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/components/CoverCamera.tsx src/components/BurstFramePicker.tsx src/components/QuadCropEditor.tsx
git commit -m "feat: theme camera-flow chrome (CoverCamera, BurstFramePicker, QuadCropEditor)"
```

---

### Task 12: Edit-copy-cover forms

**Files:**
- Modify: `src/components/EditCopyForm.tsx`
- Modify: `src/components/EditEbookCopyCoverForm.tsx`
- Modify: `src/components/EditAudiobookCopyCoverForm.tsx`

- [ ] **Step 1: Theme `EditCopyForm`**

Replace `src/components/EditCopyForm.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { updateCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";
import { CoverEditor } from "@/components/CoverEditor";
import { Button } from "@/components/ui/Button";

const initialState: CopyFormState = {};

interface EditCopyFormProps {
  copyId: string;
  bookId: string;
  defaultFormat: string;
  defaultPublisher: string;
  defaultPublishYear: string;
  defaultSpecialNotes: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditCopyForm({
  copyId,
  bookId,
  defaultFormat,
  defaultPublisher,
  defaultPublishYear,
  defaultSpecialNotes,
  currentCoverPath,
  bookIsbn,
}: EditCopyFormProps) {
  const updateThisCopy = updateCopy.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields
        idPrefix={copyId}
        defaultFormat={defaultFormat}
        defaultPublisher={defaultPublisher}
        defaultPublishYear={defaultPublishYear}
        defaultSpecialNotes={defaultSpecialNotes}
      />
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        allowCamera
        onBusyChange={setIsPreparingCover}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending || isPreparingCover} className="w-full">
        {isPending ? "Saving..." : isPreparingCover ? "Preparing cover..." : "Save"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Theme `EditEbookCopyCoverForm`**

Replace `src/components/EditEbookCopyCoverForm.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { updateEbookCopyCover } from "@/lib/actions/ebookCopies";
import type { CopyFormState } from "@/lib/copies";
import { CoverEditor } from "@/components/CoverEditor";
import { Button } from "@/components/ui/Button";

const initialState: CopyFormState = {};

interface EditEbookCopyCoverFormProps {
  copyId: string;
  bookId: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditEbookCopyCoverForm({
  copyId,
  bookId,
  currentCoverPath,
  bookIsbn,
}: EditEbookCopyCoverFormProps) {
  const updateThisCopy = updateEbookCopyCover.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        onBusyChange={setIsPreparingCover}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending || isPreparingCover} className="w-full">
        {isPending ? "Saving..." : isPreparingCover ? "Preparing cover..." : "Save"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Theme `EditAudiobookCopyCoverForm`**

Replace `src/components/EditAudiobookCopyCoverForm.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import { updateAudiobookCopyCover } from "@/lib/actions/audiobookCopies";
import type { CopyFormState } from "@/lib/copies";
import { CoverEditor } from "@/components/CoverEditor";
import { Button } from "@/components/ui/Button";

const initialState: CopyFormState = {};

interface EditAudiobookCopyCoverFormProps {
  copyId: string;
  bookId: string;
  currentCoverPath: string | null;
  bookIsbn: string | null;
}

export function EditAudiobookCopyCoverForm({
  copyId,
  bookId,
  currentCoverPath,
  bookIsbn,
}: EditAudiobookCopyCoverFormProps) {
  const updateThisCopy = updateAudiobookCopyCover.bind(null, copyId, bookId);
  const [state, formAction, isPending] = useActionState(updateThisCopy, initialState);
  const [isPreparingCover, setIsPreparingCover] = useState(false);

  return (
    <form action={formAction} className="space-y-4">
      <CoverEditor
        currentCoverPath={currentCoverPath}
        bookIsbn={bookIsbn}
        onBusyChange={setIsPreparingCover}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending || isPreparingCover} className="w-full">
        {isPending ? "Saving..." : isPreparingCover ? "Preparing cover..." : "Save"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 4: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/EditCopyForm.tsx src/components/EditEbookCopyCoverForm.tsx src/components/EditAudiobookCopyCoverForm.tsx
git commit -m "feat: theme edit-copy-cover forms"
```

---

### Task 13: Home page (`/`)

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Theme the home page**

Replace `src/app/page.tsx`:

```tsx
import Link from "next/link";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
} from "@/lib/search";
import { RefreshSyncButton } from "@/components/RefreshSyncButton";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { CatalogFilters } from "@/components/CatalogFilters";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);

  const results = await searchCatalog({ query, types, format, status, statusMode });
  const hasActiveFilters = Boolean(query || types || format || status);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">Book Catalog</h1>
        <RefreshSyncButton />
      </div>

      <form action="/" method="get" className="mb-4 space-y-2">
        <SearchAutocomplete
          scope="home"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
        />
        <CatalogFilters types={types} status={status} statusMode={statusMode} format={format} />
      </form>

      <div className="mb-4 flex gap-4 text-sm">
        <Link href="/books" className="text-accent underline">
          Manage all books
        </Link>
        <Link href="/tbr" className="text-accent underline">
          TBR gap view
        </Link>
      </div>

      {hasActiveFilters && results.length === 0 && (
        <p className="text-foreground/70">No matches found.</p>
      )}

      {results.length > 0 && (
        <ul className="space-y-3">
          {results.map((result) => (
            <CatalogResultCard key={result.bookId ?? result.title} result={result} />
          ))}
        </ul>
      )}

      <form action="/api/logout" method="post" className="mt-6">
        <button type="submit" className="text-sm text-accent underline">
          Log out
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, confirm `/` renders the masthead, themed heading, search, filters, result cards, nav links, and log-out link, and that submitting search/filters still works.

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: theme home page"
```

---

### Task 14: Login page

**Files:**
- Modify: `src/app/login/page.tsx`

- [ ] **Step 1: Theme the login page**

Replace `src/app/login/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        router.push("/");
        router.refresh();
      } else {
        const data = await res.json();
        setError(data.error ?? "Login failed");
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-dashed border-perforation bg-surface p-6"
      >
        <h1 className="font-display text-xl font-semibold text-foreground-strong">Book Catalog</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          className="w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          autoFocus
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" disabled={isSubmitting} className="w-full">
          Log in
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, log out and confirm `/login` still renders the masthead above the centered themed form, and that logging in with the correct password still redirects to `/`.

- [ ] **Step 3: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat: theme login page"
```

---

### Task 15: `/books` and `/books/new` pages

**Files:**
- Modify: `src/app/books/page.tsx`
- Modify: `src/app/books/new/page.tsx`

- [ ] **Step 1: Theme `/books`**

Replace `src/app/books/page.tsx`:

```tsx
import Link from "next/link";
import {
  searchCatalog,
  parseFormatParam,
  parseTypesParam,
  parseStatusParam,
  parseStatusModeParam,
} from "@/lib/search";
import { CatalogFilters } from "@/components/CatalogFilters";
import { CatalogResultCard } from "@/components/CatalogResultCard";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

export default async function BooksPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    types?: string | string[];
    format?: string;
    status?: string | string[];
    statusMode?: string;
  }>;
}) {
  const {
    q,
    types: typesParam,
    format: formatParam,
    status: statusParam,
    statusMode: statusModeParam,
  } = await searchParams;
  const query = q?.trim() ?? "";
  const types = parseTypesParam(typesParam);
  const format = parseFormatParam(formatParam);
  const status = parseStatusParam(statusParam);
  const statusMode = parseStatusModeParam(statusModeParam);

  const results = await searchCatalog({
    query,
    types,
    format,
    status,
    statusMode,
    browseAll: true,
    sortBy: "title",
  });

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">All Books</h1>
        <Link
          href="/books/scan"
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.primary}`}
        >
          + Add a book
        </Link>
      </div>

      <div className="mb-4 text-sm">
        <Link href="/books/duplicates" className="text-accent underline">
          Check for duplicate books
        </Link>
      </div>

      <form action="/books" method="get" className="mb-4 space-y-2">
        <SearchAutocomplete
          scope="books"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
        />
        <CatalogFilters types={types} status={status} statusMode={statusMode} format={format} />
      </form>

      {results.length === 0 ? (
        <p className="text-foreground/70">No books found.</p>
      ) : (
        <ul className="space-y-3">
          {results.map((result) => (
            <CatalogResultCard key={result.bookId ?? result.title} result={result} />
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Theme `/books/new`**

Replace `src/app/books/new/page.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { createBookWithCopy } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { CopyFormFields } from "@/components/CopyFormFields";
import { BookFormFields } from "@/components/BookFormFields";
import { Button } from "@/components/ui/Button";

const initialState: BookFormState = {};

export default function NewBookPage() {
  const [state, formAction, isPending] = useActionState(createBookWithCopy, initialState);

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 font-display text-2xl font-semibold text-foreground-strong">Add a Book</h1>
      <form action={formAction} className="space-y-4">
        <BookFormFields />

        <CopyFormFields />

        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        <Button type="submit" disabled={isPending} className="w-full">
          {isPending ? "Saving..." : "Save"}
        </Button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, confirm `/books` renders themed results and its primary "+ Add a book" link, and `/books/new` still creates a book successfully on submit.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/page.tsx src/app/books/new/page.tsx
git commit -m "feat: theme /books and /books/new pages"
```

---

### Task 16: `/books/scan` page and `ScanAddForm`

**Files:**
- Modify: `src/app/books/scan/page.tsx`
- Modify: `src/app/books/scan/ScanAddForm.tsx`

- [ ] **Step 1: Theme the page shell**

Replace `src/app/books/scan/page.tsx`:

```tsx
import { ScanAddForm } from "./ScanAddForm";

export default function ScanAddPage() {
  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-4 font-display text-2xl font-semibold text-foreground-strong">Scan a Book</h1>
      <ScanAddForm />
    </main>
  );
}
```

- [ ] **Step 2: Theme `ScanAddForm`**

Replace `src/app/books/scan/ScanAddForm.tsx`:

```tsx
"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createBookFromScan, type ScanFormState } from "@/lib/actions/books";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { CoverCamera } from "@/components/CoverCamera";
import { CoverPicker } from "@/components/CoverPicker";
import { CopyFormFields } from "@/components/CopyFormFields";
import { Button } from "@/components/ui/Button";

const initialState: ScanFormState = {};

// Kept as a small local check (not imported from src/lib/books.ts's
// normalizeIsbn) since that module pulls in the Prisma client at the top
// level, which can't run in the browser -- same reasoning
// /api/isbn-lookup/route.ts's own local normalizeIsbn copy documents.
function looksLikeValidIsbn(raw: string): boolean {
  const normalized = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  return /^(\d{13}|\d{9}[\dX])$/.test(normalized);
}

interface LookupData {
  title: string;
  author: string;
  publisher: string;
  publishYear: string;
  coverUrl: string | null;
}

interface ScanBookFormProps {
  isbn: string;
  capturedImage: string | null;
  lookup: LookupData | null;
  lookupNotice: string | null;
  onRetake: () => void;
}

// Rendered with `key={isbn}` by ScanAddForm so that a fresh scan fully
// remounts this component, resetting its useActionState state — otherwise a
// stale error from a previous failed submission would persist across
// rescans. A failed submission on the SAME isbn does not remount this
// component; `state.values` (returned by the action on error) covers that
// case by re-supplying whatever was last submitted as each field's
// defaultValue.
function ScanBookForm({ isbn, capturedImage, lookup, lookupNotice, onRetake }: ScanBookFormProps) {
  const [state, formAction, isPending] = useActionState(createBookFromScan, initialState);
  const fieldClass =
    "mt-1 w-full rounded-lg border border-perforation bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <form action={formAction} className="space-y-4">
      {/*
        Only submitted when the scanned text actually looks like an ISBN --
        /api/isbn-lookup already rejects anything else for the lookup step,
        but the raw scanned text was still being submitted here regardless,
        risking a malformed non-ISBN value (e.g. a misread barcode) getting
        persisted as this book's isbn on save. An empty value here means the
        server stores null, matching a manually-entered book with no ISBN.
      */}
      <input type="hidden" name="isbn" value={looksLikeValidIsbn(isbn) ? isbn : ""} />
      {lookupNotice && <p className="text-sm text-foreground/70">{lookupNotice}</p>}
      <div>
        <label htmlFor="title" className="block text-sm font-medium text-foreground">
          Title
        </label>
        <input
          id="title"
          name="title"
          defaultValue={state.values?.title ?? lookup?.title}
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor="author" className="block text-sm font-medium text-foreground">
          Author
        </label>
        <input
          id="author"
          name="author"
          defaultValue={state.values?.author ?? lookup?.author}
          className={fieldClass}
        />
      </div>
      <CoverPicker
        capturedImageDataUrl={capturedImage}
        openLibraryCoverUrl={lookup?.coverUrl ?? null}
        onRetake={onRetake}
      />
      {/*
        Keyed by the resolved values so a failed submission remounts these
        fields with the just-submitted values as their fresh defaults.
        This isn't just belt-and-suspenders: React's <select> caches its
        *first-ever* mount-time default and silently re-applies that cached
        value on every later render, ignoring a subsequently-updated
        defaultFormat prop — plain <input>/<textarea> don't have this
        quirk, but without remounting, the format dropdown would reset to
        blank after every failed save regardless of what defaultFormat says.
      */}
      <CopyFormFields
        key={JSON.stringify(state.values)}
        defaultFormat={state.values?.format}
        defaultPublisher={state.values?.publisher ?? lookup?.publisher}
        defaultPublishYear={state.values?.publishYear ?? lookup?.publishYear}
        defaultSpecialNotes={state.values?.specialNotes}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex gap-3">
        <Button type="submit" disabled={isPending} className="flex-1">
          {isPending ? "Saving..." : "Save"}
        </Button>
        <Button
          type="submit"
          name="scanAnother"
          value="true"
          variant="secondary"
          disabled={isPending}
          className="flex-1"
        >
          Save &amp; Scan Another
        </Button>
      </div>
    </form>
  );
}

export function ScanAddForm() {
  const [isbn, setIsbn] = useState<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(true);
  const [lookup, setLookup] = useState<LookupData | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [lookupNotice, setLookupNotice] = useState<string | null>(null);

  async function handleDecode(decodedIsbn: string) {
    setIsbn(decodedIsbn);
    setCapturedImage(null);
    setShowCamera(true);
    setIsLookingUp(true);
    setLookupNotice(null);

    try {
      const response = await fetch(`/api/isbn-lookup?isbn=${encodeURIComponent(decodedIsbn)}`);
      const data = await response.json();

      // The route returns a non-2xx status (e.g. 400 when the decoded
      // barcode text doesn't look like an ISBN -- some books carry a second,
      // non-ISBN barcode, like a UPC price/retail code, that the scanner can
      // pick up instead) with an `{ error }` body, not a lookup result. Never
      // treat that body's (nonexistent) title/author/etc. fields as real
      // data -- doing so previously produced a silently blank form with no
      // indication anything had gone wrong.
      if (!response.ok) {
        setLookup({ title: "", author: "", publisher: "", publishYear: "", coverUrl: null });
        // Prefer the route's own { error } message when present -- it's the
        // more accurate, single source of truth (see /api/isbn-lookup) and
        // stays correct if that route's validation message ever changes.
        setLookupNotice(
          typeof data.error === "string" && data.error
            ? data.error
            : "Couldn't recognize that barcode as an ISBN. Enter the details below manually, or try scanning again.",
        );
        return;
      }

      setLookup({
        title: data.title ?? "",
        author: data.author ?? "",
        publisher: data.publisher ?? "",
        publishYear: data.publishYear?.toString() ?? "",
        coverUrl: data.coverUrl ?? null,
      });
      // Only when EVERY field came back empty -- lookupIsbn's real-world
      // shape means a genuinely partial result (e.g. title present but no
      // cover) is plausible, and "No details found" would be inaccurate
      // (and confusing) if some fields actually did populate.
      if (!data.title && !data.author && !data.publisher && !data.publishYear && !data.coverUrl) {
        setLookupNotice("No details found for this ISBN. Enter them below manually.");
      }
    } catch {
      setLookup({ title: "", author: "", publisher: "", publishYear: "", coverUrl: null });
      setLookupNotice("Couldn't reach the lookup service. Enter the details below manually.");
    } finally {
      setIsLookingUp(false);
    }
  }

  if (!isbn) {
    return (
      <div>
        <BarcodeScanner onDecode={handleDecode} />
        <Link href="/books/new" className="mt-4 inline-block text-sm text-accent underline">
          Enter manually instead
        </Link>
      </div>
    );
  }

  if (isLookingUp) {
    return <p className="text-foreground">Looking up ISBN {isbn}...</p>;
  }

  return (
    <div className="relative">
      <ScanBookForm
        key={isbn}
        isbn={isbn}
        capturedImage={capturedImage}
        lookup={lookup}
        lookupNotice={lookupNotice}
        onRetake={() => setShowCamera(true)}
      />
      {/*
        Rendered as an overlay (not swapped in for the form) so that
        "Retake photo"/"Add a photo" — reopening this — never unmounts
        ScanBookForm. If it did, any in-progress edits to title/format/etc.
        the user had already typed (uncontrolled inputs, not yet submitted)
        would be lost when the form remounted with only the original lookup
        defaults.

        onRetake deliberately does NOT clear capturedImage up front: it's
        only replaced if CoverCamera's onCapture actually fires with a new
        photo below. Clearing it eagerly would lose an already-good photo
        if the user opens this overlay and then hits Skip instead of taking
        a new one.
      */}
      {showCamera && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Take a cover photo"
          className="fixed inset-0 z-10 overflow-y-auto bg-background p-4"
        >
          <CoverCamera
            onCapture={(dataUrl) => {
              setCapturedImage(dataUrl);
              setShowCamera(false);
            }}
            onSkip={() => setShowCamera(false)}
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server (over HTTPS or `localhost`, required for camera access), confirm the scan flow — barcode decode, cover camera overlay, form submit — still works end to end with the new theme applied.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/scan/page.tsx src/app/books/scan/ScanAddForm.tsx
git commit -m "feat: theme /books/scan page and ScanAddForm"
```

---

### Task 17: `/books/duplicates` page and `MergeButton`

**Files:**
- Modify: `src/app/books/duplicates/page.tsx`
- Modify: `src/app/books/duplicates/MergeButton.tsx`

- [ ] **Step 1: Theme `MergeButton`**

Replace `src/app/books/duplicates/MergeButton.tsx`:

```tsx
"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";

// Split out of page.tsx (a Server Component) so this one button can read
// pending state from its enclosing <form> via useFormStatus -- each group's
// form is independent, so only the clicked button shows "Merging...",
// not every button on the page. Without this, a merge click had zero
// visual feedback until the whole page re-rendered on success, which read
// as "the button doesn't do anything" even though the merge succeeded.
export function MergeButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" disabled={pending} className="mt-1">
      {pending ? "Merging..." : "Keep this one, merge the others into it"}
    </Button>
  );
}
```

- [ ] **Step 2: Theme the duplicates page**

Replace `src/app/books/duplicates/page.tsx`:

```tsx
import Link from "next/link";
import { findDuplicateBookGroups } from "@/lib/duplicates";
import { mergeBooks } from "@/lib/actions/duplicates";
import { MergeButton } from "@/app/books/duplicates/MergeButton";
import { TicketCard } from "@/components/ui/TicketCard";

export const dynamic = "force-dynamic";

export default async function DuplicateBooksPage() {
  const { groups, truncated } = await findDuplicateBookGroups();

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">
          Possible Duplicate Books
        </h1>
        <Link href="/books" className="text-sm text-accent underline">
          Back to All Books
        </Link>
      </div>
      <p className="mb-4 text-sm text-foreground/70">
        Books grouped here have closely-matching titles and may be the same book split across
        multiple rows (e.g. a physical copy scanned separately from an already-owned ebook or
        audiobook). Review each group and, if they really are the same book, pick the one to keep
        — its title, author, and ISBN are kept as-is; the others&apos; physical copies and
        ebook/audiobook ownership move onto it, and the other rows are removed.
      </p>
      {truncated && (
        <p className="mb-4 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
          Duplicate detection stopped early to stay fast — some duplicates may not be shown below.
          Try again later, or run this less often if it keeps happening.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="text-foreground/70">No likely duplicates found.</p>
      ) : (
        <ul className="space-y-6">
          {groups.map((group) => (
            <TicketCard key={group.books.map((book) => book.id).join(",")} className="p-3">
              <ul className="space-y-2">
                {group.books.map((book) => (
                  <li key={book.id} className="rounded-lg border border-perforation p-2 text-sm">
                    <p className="font-medium text-foreground-strong">{book.title}</p>
                    {book.author && <p className="text-foreground/70">{book.author}</p>}
                    {book.isbn && <p className="font-mono text-foreground/70">ISBN: {book.isbn}</p>}
                    <p className="text-foreground/70">
                      {book.copiesCount} {book.copiesCount === 1 ? "copy" : "copies"}
                      {book.hasEbook ? ", ebook" : ""}
                      {book.hasAudiobook ? ", audiobook" : ""}
                    </p>
                    <form
                      action={mergeBooks.bind(
                        null,
                        book.id,
                        group.books.filter((other) => other.id !== book.id).map((other) => other.id),
                      )}
                    >
                      <MergeButton />
                    </form>
                  </li>
                ))}
              </ul>
            </TicketCard>
          ))}
        </ul>
      )}
    </main>
  );
}
```

The nested per-book row inside each group keeps a solid `border-perforation` (not dashed) — a deliberate subordinate tier below the outer dashed "ticket," so a group of duplicates doesn't read as a stack of separate tickets. The `truncated` warning banner keeps its literal amber colors — the design spec doesn't define a warning/danger palette, so system-status colors (this warning, and every `text-red-600` error message across the app) stay as Tailwind's defaults rather than being force-fit into the six named tokens.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, confirm `/books/duplicates` renders themed groups and that clicking "Keep this one..." still merges correctly.

- [ ] **Step 4: Commit**

```bash
git add src/app/books/duplicates/page.tsx src/app/books/duplicates/MergeButton.tsx
git commit -m "feat: theme /books/duplicates page and MergeButton"
```

---

### Task 18: `/books/[id]` detail page

**Files:**
- Modify: `src/app/books/[id]/page.tsx`

- [ ] **Step 1: Theme the book detail page**

Replace `src/app/books/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { deleteCopy } from "@/lib/actions/copies";
import { FORMAT_LABELS } from "@/components/CopyFormFields";
import { TicketCard } from "@/components/ui/TicketCard";
import { BUTTON_VARIANT_CLASSES } from "@/components/ui/Button";

export default async function BookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({
    where: { id },
    include: {
      copies: { orderBy: { createdAt: "asc" } },
      ebookCopies: { orderBy: { createdAt: "asc" } },
      audiobookCopies: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground-strong">{book.title}</h1>
          {book.author && <p className="text-foreground/70">{book.author}</p>}
          {book.isbn && <p className="font-mono text-sm text-foreground/70">ISBN: {book.isbn}</p>}
        </div>
        <Link
          href={`/books/${book.id}/edit`}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.secondary}`}
        >
          Edit
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-medium text-foreground-strong">
          Copies ({book.copies.length})
        </h2>
        <Link
          href={`/books/${book.id}/copies/new`}
          className={`rounded-lg px-3 py-2 text-sm font-medium ${BUTTON_VARIANT_CLASSES.primary}`}
        >
          + Add a copy
        </Link>
      </div>

      <ul className="space-y-3">
        {book.copies.map((copy) => (
          <TicketCard key={copy.id} className="p-3">
            <p className="font-medium text-foreground-strong">{FORMAT_LABELS[copy.format]}</p>
            {copy.publisher && <p className="text-sm text-foreground/70">{copy.publisher}</p>}
            {copy.publishYear && <p className="font-mono text-sm text-foreground/70">{copy.publishYear}</p>}
            {copy.specialNotes && <p className="text-sm text-foreground/70">{copy.specialNotes}</p>}
            {copy.coverImagePath && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                alt="Cover"
                className="mt-2 h-32 w-24 rounded object-cover"
              />
            )}
            <div className="mt-2 flex gap-2">
              <Link href={`/books/${book.id}/edit#copy-${copy.id}`} className="text-sm text-accent underline">
                Edit
              </Link>
              <form action={deleteCopy.bind(null, copy.id)}>
                <button type="submit" className="text-sm text-red-600 underline">
                  Delete
                </button>
              </form>
            </div>
          </TicketCard>
        ))}
      </ul>

      {book.ebookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 font-display text-lg font-medium text-foreground-strong">
            Ebooks ({book.ebookCopies.length})
          </h2>
          <ul className="space-y-3">
            {book.ebookCopies.map((copy) => (
              <TicketCard key={copy.id} className="p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-foreground/70">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/edit#copy-${copy.id}`}
                  className="mt-2 inline-block text-sm text-accent underline"
                >
                  Edit cover
                </Link>
              </TicketCard>
            ))}
          </ul>
        </>
      )}

      {book.audiobookCopies.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 font-display text-lg font-medium text-foreground-strong">
            Audiobooks ({book.audiobookCopies.length})
          </h2>
          <ul className="space-y-3">
            {book.audiobookCopies.map((copy) => (
              <TicketCard key={copy.id} className="p-3">
                {copy.coverImagePath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/covers/${encodeURIComponent(copy.coverImagePath)}`}
                    alt="Cover"
                    className="h-32 w-24 rounded object-cover"
                  />
                ) : (
                  <p className="text-sm text-foreground/70">No cover set.</p>
                )}
                <Link
                  href={`/books/${book.id}/edit#copy-${copy.id}`}
                  className="mt-2 inline-block text-sm text-accent underline"
                >
                  Edit cover
                </Link>
              </TicketCard>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
```

The "Delete" action deliberately stays a plain red underlined text link, not a themed `Button` — matching the earlier decision that destructive-action color stays Tailwind's default red rather than being folded into the six-token palette, and keeping it visually lightweight rather than a prominent button matches its existing low-emphasis treatment.

- [ ] **Step 2: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, open a book's detail page and confirm the copies/ebooks/audiobooks sections render as themed ticket cards, and that "Edit", "+ Add a copy", and "Delete" all still navigate/act correctly.

- [ ] **Step 3: Commit**

```bash
git add "src/app/books/[id]/page.tsx"
git commit -m "feat: theme book detail page"
```

---

### Task 19: `/books/[id]/edit` page and `EditBookForm`

**Files:**
- Modify: `src/app/books/[id]/edit/page.tsx`
- Modify: `src/app/books/[id]/edit/EditBookForm.tsx`

- [ ] **Step 1: Theme `EditBookForm`**

Replace `src/app/books/[id]/edit/EditBookForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { updateBook } from "@/lib/actions/books";
import type { BookFormState } from "@/lib/books";
import { BookFormFields } from "@/components/BookFormFields";
import { Button } from "@/components/ui/Button";

const initialState: BookFormState = {};

interface EditBookFormProps {
  bookId: string;
  defaultTitle: string;
  defaultAuthor: string;
  defaultIsbn: string;
}

export function EditBookForm({
  bookId,
  defaultTitle,
  defaultAuthor,
  defaultIsbn,
}: EditBookFormProps) {
  const updateBookWithId = updateBook.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(updateBookWithId, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <BookFormFields
        defaultTitle={defaultTitle}
        defaultAuthor={defaultAuthor}
        defaultIsbn={defaultIsbn}
      />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? "Saving..." : "Save"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Theme the edit page**

Replace `src/app/books/[id]/edit/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditBookForm } from "./EditBookForm";
import { EditCopyForm } from "@/components/EditCopyForm";
import { EditEbookCopyCoverForm } from "@/components/EditEbookCopyCoverForm";
import { EditAudiobookCopyCoverForm } from "@/components/EditAudiobookCopyCoverForm";
import {
  updateReadStatus,
  updateRating,
  clearReadStatusManual,
  clearRatingManual,
} from "@/lib/actions/readingProgress";
import { READ_STATUS_OPTIONS, RATING_OPTIONS } from "@/components/ReadingProgressFields";
import { TicketCard } from "@/components/ui/TicketCard";
import { Button } from "@/components/ui/Button";

export default async function EditBookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({
    where: { id },
    include: {
      copies: { orderBy: { createdAt: "asc" } },
      ebookCopies: { orderBy: { createdAt: "asc" } },
      audiobookCopies: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!book) {
    notFound();
  }

  const selectClass =
    "rounded-lg border border-perforation bg-background px-2 py-1 text-sm text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent";

  return (
    <main className="mx-auto max-w-lg space-y-8 p-4">
      <div>
        <h1 className="mb-4 font-display text-2xl font-semibold text-foreground-strong">Edit Book</h1>
        <EditBookForm
          bookId={book.id}
          defaultTitle={book.title}
          defaultAuthor={book.author ?? ""}
          defaultIsbn={book.isbn ?? ""}
        />
      </div>

      <TicketCard as="div" className="space-y-2 p-3">
        <h2 className="font-display text-lg font-medium text-foreground-strong">Reading Progress</h2>
        <div className="flex flex-wrap items-center gap-2">
          <form action={updateReadStatus.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="readStatus" className="text-sm font-medium text-foreground">
              Status
            </label>
            <select
              id="readStatus"
              name="readStatus"
              defaultValue={book.readStatus ?? ""}
              className={selectClass}
            >
              <option value="">Not set</option>
              {READ_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
          <span className="text-xs text-foreground/70">
            {book.readStatusManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.readStatusManual && (
            <form action={clearReadStatusManual.bind(null, book.id)}>
              <button type="submit" className="text-xs text-accent underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form action={updateRating.bind(null, book.id)} className="flex items-center gap-2">
            <label htmlFor="rating" className="text-sm font-medium text-foreground">
              Rating
            </label>
            <select
              id="rating"
              name="rating"
              defaultValue={book.rating?.toString() ?? ""}
              className={selectClass}
            >
              <option value="">Unrated</option>
              {RATING_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "star" : "stars"}
                </option>
              ))}
            </select>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </form>
          <span className="text-xs text-foreground/70">
            {book.ratingManual ? "Manually set" : "Synced from Goodreads"}
          </span>
          {book.ratingManual && (
            <form action={clearRatingManual.bind(null, book.id)}>
              <button type="submit" className="text-xs text-accent underline">
                Let Goodreads manage this again
              </button>
            </form>
          )}
        </div>
      </TicketCard>

      {book.copies.length > 0 && (
        <div>
          <h2 className="mb-2 font-display text-lg font-medium text-foreground-strong">Physical Copies</h2>
          <div className="space-y-6">
            {book.copies.map((copy, index) => (
              <TicketCard as="div" key={copy.id} id={`copy-${copy.id}`} className="scroll-mt-4 p-3">
                <h3 className="mb-2 font-mono text-sm font-semibold uppercase tracking-wide text-foreground/70">
                  Physical Copy #{index + 1}
                </h3>
                <EditCopyForm
                  copyId={copy.id}
                  bookId={book.id}
                  defaultFormat={copy.format}
                  defaultPublisher={copy.publisher ?? ""}
                  defaultPublishYear={copy.publishYear?.toString() ?? ""}
                  defaultSpecialNotes={copy.specialNotes ?? ""}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </TicketCard>
            ))}
          </div>
        </div>
      )}

      {book.ebookCopies.length > 0 && (
        <div>
          <h2 className="mb-2 font-display text-lg font-medium text-foreground-strong">Ebooks</h2>
          <div className="space-y-6">
            {book.ebookCopies.map((copy, index) => (
              <TicketCard as="div" key={copy.id} id={`copy-${copy.id}`} className="scroll-mt-4 p-3">
                <h3 className="mb-2 font-mono text-sm font-semibold uppercase tracking-wide text-foreground/70">
                  Ebook #{index + 1}
                </h3>
                <EditEbookCopyCoverForm
                  copyId={copy.id}
                  bookId={book.id}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </TicketCard>
            ))}
          </div>
        </div>
      )}

      {book.audiobookCopies.length > 0 && (
        <div>
          <h2 className="mb-2 font-display text-lg font-medium text-foreground-strong">Audiobooks</h2>
          <div className="space-y-6">
            {book.audiobookCopies.map((copy, index) => (
              <TicketCard as="div" key={copy.id} id={`copy-${copy.id}`} className="scroll-mt-4 p-3">
                <h3 className="mb-2 font-mono text-sm font-semibold uppercase tracking-wide text-foreground/70">
                  Audiobook #{index + 1}
                </h3>
                <EditAudiobookCopyCoverForm
                  copyId={copy.id}
                  bookId={book.id}
                  currentCoverPath={copy.coverImagePath}
                  bookIsbn={book.isbn}
                />
              </TicketCard>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
```

`TicketCard` forwards `id` through its spread `{...props}` (it extends `HTMLAttributes<HTMLElement>`), so the `id={`copy-${copy.id}`}` + `scroll-mt-4` deep-linking behavior established in PR #32 is preserved exactly — this is the one place in the reskin where breaking existing behavior would be easy to miss, so it's called out explicitly here.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, open `/books/[id]/edit`, confirm the Reading Progress card and each copy's themed section render correctly, that Save buttons still work for status/rating/copy fields, and that navigating to `/books/[id]/edit#copy-<id>` from the detail page still scrolls to and highlights the right section.

- [ ] **Step 4: Commit**

```bash
git add "src/app/books/[id]/edit/page.tsx" "src/app/books/[id]/edit/EditBookForm.tsx"
git commit -m "feat: theme book edit page"
```

---

### Task 20: `/books/[id]/copies/new` page and `AddCopyForm`

**Files:**
- Modify: `src/app/books/[id]/copies/new/page.tsx`
- Modify: `src/app/books/[id]/copies/new/AddCopyForm.tsx`

- [ ] **Step 1: Theme `AddCopyForm`**

Replace `src/app/books/[id]/copies/new/AddCopyForm.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { addCopy } from "@/lib/actions/copies";
import type { CopyFormState } from "@/lib/copies";
import { CopyFormFields } from "@/components/CopyFormFields";
import { Button } from "@/components/ui/Button";

const initialState: CopyFormState = {};

export function AddCopyForm({ bookId }: { bookId: string }) {
  const addCopyForBook = addCopy.bind(null, bookId);
  const [state, formAction, isPending] = useActionState(addCopyForBook, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <CopyFormFields />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? "Saving..." : "Save"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Theme the page shell**

Replace `src/app/books/[id]/copies/new/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AddCopyForm } from "./AddCopyForm";

export default async function AddCopyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const book = await prisma.book.findUnique({ where: { id } });

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-lg p-4">
      <h1 className="mb-1 font-display text-2xl font-semibold text-foreground-strong">Add a Copy</h1>
      <p className="mb-4 text-foreground/70">{book.title}</p>
      <AddCopyForm bookId={book.id} />
    </main>
  );
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, confirm `/books/[id]/copies/new` still adds a physical copy successfully.

- [ ] **Step 4: Commit**

```bash
git add "src/app/books/[id]/copies/new/page.tsx" "src/app/books/[id]/copies/new/AddCopyForm.tsx"
git commit -m "feat: theme add-copy page"
```

---

### Task 21: `/tbr` page

**Files:**
- Modify: `src/app/tbr/page.tsx`

- [ ] **Step 1: Theme the TBR gap page**

Replace `src/app/tbr/page.tsx`:

```tsx
import Link from "next/link";
import { getTbrGap, groupByInitial } from "@/lib/tbrGap";
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
import { TicketCard } from "@/components/ui/TicketCard";

export const dynamic = "force-dynamic";

// The "#" bucket (groupByInitial's catch-all for non-letter first characters)
// can't be used directly in an href/id -- "#" is meaningful in a URL fragment
// and awkward to reference from a CSS/JS selector, so it gets a dedicated
// anchor token here while the visible jump-nav label stays "#".
function anchorId(letter: string): string {
  return letter === "#" ? "letter-hash" : `letter-${letter}`;
}

export default async function TbrGapPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const gap = await getTbrGap(query);
  const groups = groupByInitial(gap);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-2xl font-semibold text-foreground-strong">TBR — Not Yet Owned</h1>
        <Link href="/" className="text-sm text-accent underline">
          Back to search
        </Link>
      </div>

      <form action="/tbr" method="get" className="mb-4">
        <SearchAutocomplete
          scope="tbr"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
        />
      </form>

      {groups.length > 0 && (
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Jump to letter">
          {groups.map((group) => (
            <a key={group.letter} href={`#${anchorId(group.letter)}`} className="text-accent underline">
              {group.letter}
            </a>
          ))}
        </nav>
      )}

      {gap.length === 0 ? (
        <p className="text-foreground/70">
          {query
            ? "No matches found."
            : "Everything on your to-read shelf is already owned in some form."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.letter} className="mb-4">
            <h2
              id={anchorId(group.letter)}
              className="mb-2 font-display text-lg font-semibold text-foreground-strong"
            >
              {group.letter}
            </h2>
            <ul className="space-y-2">
              {group.items.map((item) => (
                <TicketCard key={item.id} className="p-3">
                  <CoverThumbnail coverImagePath={item.coverImagePath} />
                  <p className="font-medium text-foreground-strong">{item.title}</p>
                  {item.author && <p className="text-sm text-foreground/70">{item.author}</p>}
                </TicketCard>
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
```

- [ ] **Step 2: Verify nothing broke**

Run: `npx tsc --noEmit && npm test`
Expected: PASS. In the dev server, confirm `/tbr` renders themed items grouped by letter, the jump-nav links still scroll to the right section, and search still filters correctly.

- [ ] **Step 3: Commit**

```bash
git add src/app/tbr/page.tsx
git commit -m "feat: theme /tbr page"
```

---

### Task 22: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `npm test`
Expected: PASS, 0 failures, no new warnings.

Run: `npx tsc --noEmit`
Expected: PASS, no type errors.

Run: `npm run build`
Expected: PASS — this also exercises `next/font/google` font loading and the `icon.svg` route at build time, catching any font-loading or metadata misconfiguration `npm test`/`tsc` wouldn't.

- [ ] **Step 2: Real dev-server + Playwright walkthrough, light mode**

Start the dev server (`npm run dev`, falls back to port 3001 in this environment). Using the Playwright MCP tools with default (light) color scheme, visit every route in Scope and confirm it renders the new theme with no console errors and no broken functionality:

- `/login` — themed card, log in with a valid session (mint one per this project's established cookie-minting pattern if no real session exists locally)
- `/` — masthead, search, filters, refresh button, result cards (including a "Read" book to see the panda marker), log out
- `/books` — masthead, themed results, "+ Add a book" link
- `/books/new` — themed form, submit a book successfully
- `/books/scan` — barcode scan flow, cover camera overlay, submit
- `/books/duplicates` — themed duplicate groups (seed a duplicate pair first if none exist)
- `/books/[id]` — themed copy/ebook/audiobook sections, Edit/Delete/+Add a copy links
- `/books/[id]/edit` — themed Reading Progress card, per-copy sections, deep-link anchor (`#copy-<id>`) scrolling
- `/books/[id]/copies/new` — themed form, submit successfully
- `/tbr` — themed grouped list, jump-nav, search

- [ ] **Step 3: Repeat the walkthrough in dark mode**

Repeat Step 2 with Playwright's `colorScheme: "dark"` emulation across the same 10 routes, confirming the distinct dark palette (Night Ink/Card Dusk/Moonlit Cream/Night Sakura/Moss/Dusk Line) renders correctly and nothing is illegible or broken.

- [ ] **Step 4: Manual contrast spot-check**

Using the actual rendered pages (not just the hex values), confirm:
- Ink (`#332A22`) body text on Kraft Cream (`#F2E8D5`) background reads comfortably at body-text sizes.
- Moonlit Cream (`#EFE6D8`) body text on Night Ink (`#1D1B24`) background reads comfortably at body-text sizes.
- Primary button text (Panda Black on Sakura in light mode, Night Ink on Night Sakura in dark mode — see Task 1's note) is clearly legible, not just technically passing.

These are the two pairings the design spec's testing section calls out by name, plus the one pairing this plan corrected during Task 1; if any other pairing looks marginal during the walkthrough (e.g. Bamboo/Moss status text at `text-xs`), note it but don't block on it — the spec doesn't mandate checking every accent pairing, and a follow-up can address it in isolation if it turns out to matter in practice.

- [ ] **Step 5: Hand off**

No commit for this task (verification only). Once Steps 1-4 all pass, proceed to `superpowers:finishing-a-development-branch` for the whole branch — this plan is scoped as one PR per the user's explicit direction.
