# Search Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typeahead suggestion dropdown to the three existing search boxes (home, `/books`, `/tbr`), each sourced from that page's own data, where selecting a suggestion immediately submits the search.

**Architecture:** One shared `GET /api/autocomplete` route handler queries the right table/shape per `scope` query param (`home`/`books` both query `Book`, `tbr` queries `GoodreadsTbrItem`) and returns up to 8 `{title, author}` pairs. One shared `<SearchAutocomplete>` client component wraps a debounced fetch to that route with a keyboard-navigable dropdown, and drops into each page's existing `<form>` as a drop-in replacement for the plain `<input>`. No changes to how search results themselves are computed on any page.

**Tech Stack:** Next.js App Router route handler, Prisma, React client component (`useState`/`useEffect`/`useRef`, no external state library), Vitest against the isolated `bookcatalog_test` database (see `vitest.config.ts`).

**Spec:** `docs/superpowers/specs/2026-07-18-search-autocomplete-design.md` — approved 2026-07-18. Read it before starting; this plan implements it exactly, including its explicit non-goals (no fuzzy matching, no cross-scope suggestions, no fix for the `/books` zero-physical-copy gap).

---

### Task 1: Autocomplete API route

**Files:**
- Create: `src/app/api/autocomplete/route.ts`
- Test: `src/app/api/autocomplete/route.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// src/app/api/autocomplete/route.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

function makeRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/autocomplete");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
}

afterEach(async () => {
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Autocomplete" } } });
  await prisma.goodreadsTbrItem.deleteMany({
    where: { title: { startsWith: "Test Autocomplete" } },
  });
});

describe("GET /api/autocomplete", () => {
  it("returns 400 when scope is missing", async () => {
    const response = await GET(makeRequest({ q: "Mistborn" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid scope", async () => {
    const response = await GET(makeRequest({ scope: "nonsense", q: "Mistborn" }));
    expect(response.status).toBe(400);
  });

  it("returns an empty array without querying the database when q is under 2 characters", async () => {
    await prisma.book.create({ data: { title: "Test Autocomplete Short Query" } });

    const response = await GET(makeRequest({ scope: "home", q: "T" }));
    const data = await response.json();

    expect(data).toEqual([]);
  });

  it("returns matching title/author pairs for the home scope", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Mistborn", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "home", q: "Mistborn" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Mistborn", author: "Brandon Sanderson" }]);
  });

  it("matches on author as well as title", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Elantris", author: "Sanderson, Brandon" },
    });

    const response = await GET(makeRequest({ scope: "home", q: "Sanderson" }));
    const data = await response.json();

    expect(data.map((s: { title: string }) => s.title)).toContain("Test Autocomplete Elantris");
  });

  it("returns matching title/author pairs for the books scope", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Warbreaker", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "books", q: "Warbreaker" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Warbreaker", author: "Brandon Sanderson" }]);
  });

  it("matches a Book with zero physical copies for the books scope (deliberate parity with /books' own listing)", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Ebook Only", hasEbook: true },
    });

    const response = await GET(makeRequest({ scope: "books", q: "Ebook Only" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Ebook Only", author: null }]);
  });

  it("returns matching title/author pairs for the tbr scope", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Autocomplete Way of Kings", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "tbr", q: "Way of Kings" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Way of Kings", author: "Brandon Sanderson" }]);
  });

  it("does not leak Book rows into the tbr scope or GoodreadsTbrItem rows into the home/books scopes", async () => {
    await prisma.book.create({ data: { title: "Test Autocomplete Cross Scope Book" } });
    await prisma.goodreadsTbrItem.create({ data: { title: "Test Autocomplete Cross Scope Tbr" } });

    const tbrResponse = await GET(makeRequest({ scope: "tbr", q: "Test Autocomplete Cross Scope" }));
    const tbrData = await tbrResponse.json();
    expect(tbrData.map((s: { title: string }) => s.title)).toEqual([
      "Test Autocomplete Cross Scope Tbr",
    ]);

    const homeResponse = await GET(
      makeRequest({ scope: "home", q: "Test Autocomplete Cross Scope" }),
    );
    const homeData = await homeResponse.json();
    expect(homeData.map((s: { title: string }) => s.title)).toEqual([
      "Test Autocomplete Cross Scope Book",
    ]);
  });

  it("caps results at 8 entries", async () => {
    for (let i = 0; i < 10; i++) {
      await prisma.book.create({ data: { title: `Test Autocomplete Cap ${i}` } });
    }

    const response = await GET(makeRequest({ scope: "home", q: "Test Autocomplete Cap" }));
    const data = await response.json();

    expect(data).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/api/autocomplete/route.test.ts`
Expected: FAIL — `route.ts` doesn't exist yet, so the import errors out (`Cannot find module './route'` or equivalent).

- [ ] **Step 3: Write the route implementation**

```typescript
// src/app/api/autocomplete/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const SCOPES = ["home", "books", "tbr"] as const;
type Scope = (typeof SCOPES)[number];

const MIN_QUERY_LENGTH = 2;
const SUGGESTION_LIMIT = 8;

interface Suggestion {
  title: string;
  author: string | null;
}

function isScope(value: string | null): value is Scope {
  return value !== null && (SCOPES as readonly string[]).includes(value);
}

// "home" and "books" both suggest across the same Book table/shape, deliberately
// mirroring each page's own current search behavior -- including /books' own
// not-yet-fixed listing behavior of not requiring a physical copy (see backlog
// item #7, tracked in project memory, not fixed here). "tbr" queries the
// separate GoodreadsTbrItem table, matching /tbr's own search.
async function fetchSuggestions(scope: Scope, q: string): Promise<Suggestion[]> {
  if (scope === "tbr") {
    return prisma.goodreadsTbrItem.findMany({
      where: {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { author: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { title: true, author: true },
      take: SUGGESTION_LIMIT,
      orderBy: { title: "asc" },
    });
  }

  return prisma.book.findMany({
    where: {
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { author: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { title: true, author: true },
    take: SUGGESTION_LIMIT,
    orderBy: { title: "asc" },
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scopeParam = searchParams.get("scope");
  const q = searchParams.get("q")?.trim() ?? "";

  if (!isScope(scopeParam)) {
    return NextResponse.json({ error: "A valid scope is required" }, { status: 400 });
  }

  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json([]);
  }

  const suggestions = await fetchSuggestions(scopeParam, q);
  return NextResponse.json(suggestions);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/app/api/autocomplete/route.test.ts`
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS, 266 tests (256 existing + 10 new).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/autocomplete/route.ts src/app/api/autocomplete/route.test.ts
git commit -m "feat: add /api/autocomplete suggestion route"
```

---

### Task 2: `SearchAutocomplete` client component

**Files:**
- Create: `src/components/SearchAutocomplete.tsx`

No automated test for this task — this codebase has no precedent for testing interactive component *behavior* (the one existing `src/components/*.test.ts` file only tests a pure exported helper, not rendering/interaction; `CoverEditor`, `BarcodeScanner`, `CoverCamera`, and `CoverPicker` have never had rendered behavior under test). This component will be verified via manual browser QA in Task 3, once it's wired into a real page. This matches the spec's own "Testing" section.

- [ ] **Step 1: Write the component**

```typescript
// src/components/SearchAutocomplete.tsx
"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface Suggestion {
  title: string;
  author: string | null;
}

interface SearchAutocompleteProps {
  scope: "home" | "books" | "tbr";
  name: string;
  defaultValue: string;
  placeholder: string;
}

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

export function SearchAutocomplete({
  scope,
  name,
  defaultValue,
  placeholder,
}: SearchAutocompleteProps) {
  const [value, setValue] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set true right before setValue() in selectSuggestion, so the effect
  // below (which runs after React commits the new value to the DOM) submits
  // the form once the input's real DOM value actually matches the selection
  // -- calling requestSubmit() synchronously in the same handler as setValue
  // would race React's batched state update and could submit the OLD value.
  const submitPendingRef = useRef(false);
  // Bumped on every keystroke; a debounced fetch response only applies if
  // its id still matches the latest one when it resolves, so a slow response
  // to an earlier keystroke can never clobber a newer one that resolved first.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    const timeoutId = setTimeout(() => {
      fetch(`/api/autocomplete?scope=${scope}&q=${encodeURIComponent(trimmed)}`)
        .then((response) => (response.ok ? response.json() : []))
        .then((data: Suggestion[]) => {
          if (requestId !== requestIdRef.current) return;
          setSuggestions(data);
          setIsOpen(data.length > 0);
          setHighlightedIndex(-1);
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return;
          setSuggestions([]);
          setIsOpen(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [value, scope]);

  useEffect(() => {
    if (submitPendingRef.current) {
      submitPendingRef.current = false;
      inputRef.current?.form?.requestSubmit();
    }
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function selectSuggestion(suggestion: Suggestion) {
    submitPendingRef.current = true;
    setValue(suggestion.title);
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!isOpen || suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter") {
      // Only intercept Enter when a suggestion is actually highlighted --
      // otherwise let the keypress fall through to the browser's native
      // "Enter submits the enclosing form" behavior (matches the spec).
      if (highlightedIndex >= 0) {
        event.preventDefault();
        selectSuggestion(suggestions[highlightedIndex]);
      }
    } else if (event.key === "Escape") {
      setIsOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsOpen(suggestions.length > 0)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded border p-2"
      />
      {isOpen && (
        <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow-lg">
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.title}-${suggestion.author ?? ""}-${index}`}>
              <button
                type="button"
                onClick={() => selectSuggestion(suggestion)}
                className={`block w-full px-3 py-2 text-left text-sm ${
                  index === highlightedIndex ? "bg-gray-100" : ""
                }`}
              >
                <span className="font-medium">{suggestion.title}</span>
                {suggestion.author && (
                  <span className="ml-1 text-gray-500">— {suggestion.author}</span>
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

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/SearchAutocomplete.tsx
git commit -m "feat: add SearchAutocomplete client component"
```

---

### Task 3: Wire into the three pages

**Files:**
- Modify: `src/app/page.tsx:1-18` (import) and `:62-68` (input)
- Modify: `src/app/books/page.tsx:1-14` (import) and `:94-100` (input)
- Modify: `src/app/tbr/page.tsx:1-3` (import) and `:35-41` (input)

- [ ] **Step 1: Wire into the home page**

In `src/app/page.tsx`, add the import alongside the other component imports:

```typescript
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
```

Replace the existing text input:

```typescript
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
          className="w-full rounded border p-2"
        />
```

with:

```typescript
        <SearchAutocomplete
          scope="home"
          name="q"
          defaultValue={query}
          placeholder="Do I already own this?"
        />
```

- [ ] **Step 2: Wire into `/books`**

In `src/app/books/page.tsx`, add the import:

```typescript
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
```

Replace:

```typescript
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
          className="w-full rounded border p-2"
        />
```

with:

```typescript
        <SearchAutocomplete
          scope="books"
          name="q"
          defaultValue={query}
          placeholder="Search by title, author, or ISBN"
        />
```

- [ ] **Step 3: Wire into `/tbr`**

In `src/app/tbr/page.tsx`, add the import:

```typescript
import Link from "next/link";
import { getTbrGap, groupByInitial } from "@/lib/tbrGap";
import { CoverThumbnail } from "@/components/CoverThumbnail";
import { SearchAutocomplete } from "@/components/SearchAutocomplete";
```

Replace:

```typescript
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Search by title or author"
          className="w-full rounded border p-2"
        />
```

with:

```typescript
        <SearchAutocomplete
          scope="tbr"
          name="q"
          defaultValue={query}
          placeholder="Search by title or author"
        />
```

- [ ] **Step 4: Run the full test suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, 266 tests, no type errors.

- [ ] **Step 5: Manual browser QA**

Run: `npm run dev`, log in, and check on each of the three pages (home, `/books`, `/tbr`):
- Typing 1 character shows no dropdown and fires no network request (check the Network tab).
- Typing 2+ characters of a real title/author shows a dropdown within ~250ms, capped at 8 entries, each showing title + author when present.
- Arrow Down/Up moves the highlight, wrapping at both ends.
- Enter on a highlighted suggestion submits the search for that title.
- Enter with nothing highlighted submits the typed text normally (existing behavior, unchanged).
- Escape closes the dropdown without altering the input.
- Clicking a suggestion submits the search for that title.
- Clicking outside the dropdown closes it without changing the input.
- Confirm each page's suggestions only ever come from that page's own data (e.g. `/tbr` never suggests a title you already own).

- [ ] **Step 6: Commit**

```bash
git add src/app/page.tsx src/app/books/page.tsx src/app/tbr/page.tsx
git commit -m "feat: wire SearchAutocomplete into home, /books, and /tbr search boxes"
```

---

### Task 4: Final review and finish

- [ ] Dispatch a final code-reviewer subagent covering the whole diff against `master` (all three commits from Tasks 1-3), using the spec at `docs/superpowers/specs/2026-07-18-search-autocomplete-design.md` as the requirements reference.
- [ ] Fix any Critical/Important findings; re-review until clean.
- [ ] Use `superpowers:finishing-a-development-branch` to merge/PR the result.
