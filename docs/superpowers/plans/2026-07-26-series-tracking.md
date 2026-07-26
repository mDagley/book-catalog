# Series Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** See which books in the catalog belong to the same series, in order, from a book's detail page.

**Architecture:** Three new `Book` columns (`seriesName`, `seriesPosition`, `seriesManual`), populated by parsing Goodreads' `Title (Series Name, #N)` convention out of the title. Parsed at Book creation, backfilled for existing rows by pure SQL inside the migration, and hand-editable on the edit page. The detail page shows a "Part of" section listing siblings in order.

**Tech Stack:** TypeScript, Prisma (Postgres), Next.js 16 App Router server components, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-series-tracking-design.md` (corrected 2026-07-26 — read the correction notes in it, they change two implementation decisions).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/series.ts` (create) | `parseSeriesFromTitle` — pure, no Prisma import, mirroring `src/lib/isbn.ts`. |
| `src/lib/series.test.ts` (create) | Pure-function tests. |
| `prisma/schema.prisma` (modify) | Three new `Book` columns. |
| `prisma/migrations/<new>/migration.sql` (modify after generation) | Adds columns **and** the pure-SQL backfill. |
| `src/lib/books.ts` (modify) | Parse at scan/manual creation; `updateSeriesData`. |
| `src/lib/absSync.ts` (modify) | Parse at both ABS creation sites. |
| `src/lib/ownedPhysicalSync.ts` (modify) | Parse at owned-physical creation. |
| `src/lib/actions/books.ts` (modify) | `updateSeries` server action. |
| `src/app/books/[id]/edit/EditBookForm.tsx` (modify) | Two series fields — **not** in the shared `BookFormFields`. |
| `src/app/books/[id]/page.tsx` (modify) | The "Part of" section. |

## Facts already verified — do not re-derive or "fix" these

1. **Books are created in exactly four places:** `src/lib/books.ts:127` (scan/manual), `src/lib/absSync.ts:158` (ebook) and `:170` (audiobook), `src/lib/ownedPhysicalSync.ts:119` (owned-physical shelf). `syncGoodreadsTbr` does **not** create books — it only updates existing ones' `readStatus`/`rating`. (The spec's mention of a "TBR-item-to-Book promotion path" is wrong; no such path exists.)
2. **Postgres `regexp_match` handles the pattern**, verified against every case in the spec's Testing section — including rejecting `(Annotated Edition)` and `(Something, No Number)`. This is why the backfill is pure SQL.
3. **`docker-entrypoint.sh` runs `prisma migrate deploy` at container startup**, so the backfill applies automatically on deploy. There is no manual production step. Do not add a script or a button.
4. **`BookFormFields` is shared with `/books/new`.** Series fields must go in `EditBookForm` directly, or they appear on the add flow too.
5. **Two databases:** `.env` → `bookcatalog` (shared dev DB with the user's REAL library). `.env.test` → `bookcatalog_test` (isolated, used by the suite). Never edit either env file; never run tests against the dev DB.

---

### Task 1: `parseSeriesFromTitle`

**Files:**
- Create: `src/lib/series.ts`
- Test: `src/lib/series.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { parseSeriesFromTitle } from "@/lib/series";

describe("parseSeriesFromTitle", () => {
  it("parses a real Goodreads series title", () => {
    expect(parseSeriesFromTitle("The City of Brass (The Daevabad Trilogy, #1)")).toEqual({
      seriesName: "The Daevabad Trilogy",
      seriesPosition: 1,
    });
  });

  it("parses a decimal position for a novella", () => {
    expect(parseSeriesFromTitle("Some Novella (Series Name, #1.5)")).toEqual({
      seriesName: "Series Name",
      seriesPosition: 1.5,
    });
  });

  it("trims whitespace around the series name", () => {
    expect(parseSeriesFromTitle("Title (  Spaced Series , #2)")).toEqual({
      seriesName: "Spaced Series",
      seriesPosition: 2,
    });
  });

  it("returns null for a title with no parenthetical", () => {
    expect(parseSeriesFromTitle("Plain Title With No Suffix")).toBeNull();
  });

  it("returns null for an unrelated parenthetical", () => {
    expect(parseSeriesFromTitle("Book Title (Annotated Edition)")).toBeNull();
  });

  it("returns null when the parenthetical has a comma but no #N", () => {
    expect(parseSeriesFromTitle("Title (Something, No Number)")).toBeNull();
  });

  it("returns null when the suffix is not at the end", () => {
    expect(parseSeriesFromTitle("Title (Series, #1) and more text")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseSeriesFromTitle("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- series.test.ts`
Expected: FAIL — cannot resolve `@/lib/series`.

- [ ] **Step 3: Implement**

Create `src/lib/series.ts`:

```ts
// Parses Goodreads' long-standing "Title (Series Name, #N)" title convention.
//
// Deliberately Prisma-free (like src/lib/isbn.ts) so it can be imported from
// anywhere, including client components, without dragging in the database
// client.
//
// Goodreads' RSS feed exposes no structured series field -- confirmed by
// fetching a real shelf feed during design -- so the title string is the only
// available source. See
// docs/superpowers/specs/2026-07-20-series-tracking-design.md.
//
// The same pattern is expressed as SQL in the migration that backfills
// existing rows. That duplication is safe because a migration runs once and
// is then frozen; the two only need to agree at the moment it applies.
const SERIES_SUFFIX = /^(.+) \(([^,()]+), #(\d+(?:\.\d+)?)\)$/;

export interface ParsedSeries {
  seriesName: string;
  seriesPosition: number;
}

export function parseSeriesFromTitle(title: string): ParsedSeries | null {
  const match = SERIES_SUFFIX.exec(title);
  if (!match) return null;
  const seriesName = match[2].trim();
  if (!seriesName) return null;
  return { seriesName, seriesPosition: Number.parseFloat(match[3]) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- series.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/series.ts src/lib/series.test.ts
git commit -m "feat: add parseSeriesFromTitle"
```

---

### Task 2: Schema, migration, and SQL backfill

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: the generated `prisma/migrations/<timestamp>_add_series_fields/migration.sql`

- [ ] **Step 1: Add the columns**

In `prisma/schema.prisma`, add to `model Book`:

```prisma
  seriesName     String?
  seriesPosition Float?
  seriesManual   Boolean @default(false)
```

`seriesPosition` is `Float`, not `Int`, so novellas ("1.5") are representable. `seriesManual` mirrors the existing `readStatusManual`/`ratingManual` convention.

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_series_fields --create-only`

`--create-only` generates the SQL **without applying it**, so the backfill can be appended before it runs anywhere.

Expected: a new `prisma/migrations/<timestamp>_add_series_fields/migration.sql` containing three `ADD COLUMN` statements.

- [ ] **Step 3: Append the backfill to that same migration file**

Add below the generated `ALTER TABLE`:

```sql
-- Backfill: derive series from Goodreads' "Title (Series Name, #N)" title
-- convention for every pre-existing row. Done here as pure SQL rather than a
-- separate script or an admin button, so it applies automatically wherever
-- migrations run (docker-entrypoint.sh runs `prisma migrate deploy` at
-- container startup) and needs no manual production step.
--
-- regexp_match returns NULL when the pattern doesn't match, so rows that
-- don't follow the convention are simply left alone. Verified against the
-- spec's own cases: "(Annotated Edition)" and "(Something, No Number)" both
-- correctly fail to match.
--
-- This mirrors parseSeriesFromTitle in src/lib/series.ts, which handles every
-- row created from here on. Having the pattern twice is safe precisely
-- because this statement runs exactly once and is then frozen.
--
-- seriesManual is deliberately left at its false default: nothing here is a
-- hand-edit.
UPDATE "Book" AS b
SET "seriesName" = btrim(sub.m[2]),
    "seriesPosition" = sub.m[3]::double precision
FROM (
  SELECT id, regexp_match(title, '^(.+) \(([^,()]+), #([0-9]+(\.[0-9]+)?)\)$') AS m
  FROM "Book"
) AS sub
WHERE b.id = sub.id
  AND sub.m IS NOT NULL
  AND btrim(sub.m[2]) <> '';
```

- [ ] **Step 4: Apply to the dev database**

Run: `npx prisma migrate dev`

Expected: applies the pending migration. If it reports drift or offers to reset, STOP and report — do not accept a reset.

- [ ] **Step 5: Apply to the isolated TEST database**

`prisma migrate dev` only touches `.env`'s database. The suite uses a separate one; without this every later task's tests fail with "column seriesName does not exist".

```bash
DATABASE_URL="postgresql://bookcatalog:bookcatalog_dev@localhost:5432/bookcatalog_test" npx prisma migrate deploy
```

Do NOT edit `.env` or `.env.test` — override inline for this one command.

- [ ] **Step 6: Verify the backfill SQL actually works**

Against the **test** database only, insert a few rows directly, re-run the backfill statement by hand, and confirm results. (The migration itself has already run, so this is verifying the statement's logic, not re-running the migration.)

```bash
docker exec book-catalog-postgres-1 psql -U bookcatalog -d bookcatalog_test -c "
INSERT INTO \"Book\" (id, title) VALUES
  (gen_random_uuid()::text, 'Verify A (Some Trilogy, #1)'),
  (gen_random_uuid()::text, 'Verify B (Some Trilogy, #2.5)'),
  (gen_random_uuid()::text, 'Verify C (Annotated Edition)'),
  (gen_random_uuid()::text, 'Verify D Plain');
UPDATE \"Book\" AS b
SET \"seriesName\" = btrim(sub.m[2]), \"seriesPosition\" = sub.m[3]::double precision
FROM (SELECT id, regexp_match(title, '^(.+) \(([^,()]+), #([0-9]+(\.[0-9]+)?)\)\$') AS m FROM \"Book\") AS sub
WHERE b.id = sub.id AND sub.m IS NOT NULL AND btrim(sub.m[2]) <> '';
SELECT title, \"seriesName\", \"seriesPosition\" FROM \"Book\" WHERE title LIKE 'Verify %' ORDER BY title;
DELETE FROM \"Book\" WHERE title LIKE 'Verify %';"
```

Expected: A → `Some Trilogy`/`1`; B → `Some Trilogy`/`2.5`; C and D → both NULL. Confirm the cleanup `DELETE` left nothing behind.

- [ ] **Step 7: Confirm nothing broke**

Run: `npm test` — the existing suite should still pass (the new columns are nullable with defaults).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add series columns with SQL backfill"
```

---

### Task 3: Parse series at Book creation

**Files:**
- Modify: `src/lib/books.ts`, `src/lib/absSync.ts`, `src/lib/ownedPhysicalSync.ts`
- Test: `src/lib/books.test.ts`, `src/lib/absSync.test.ts`, `src/lib/ownedPhysicalSync.test.ts`

All four creation sites parse. The regex is a no-op for titles that don't follow the convention, so there is no reason to special-case which paths get it — and "why does this path parse but not that one" is a worse problem than a redundant no-op.

- [ ] **Step 1: Write the failing tests**

In `src/lib/books.test.ts` (match its existing fixture/cleanup conventions):

```ts
  it("parses series out of the title when creating a book", async () => {
    const result = await createBookWithCopyData({
      title: "Test Books Series Parse (Test Books Trilogy, #2)",
      author: "Someone",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });

    if ("error" in result) throw new Error(result.error);
    const book = await prisma.book.findUniqueOrThrow({ where: { id: result.bookId } });
    expect(book.seriesName).toBe("Test Books Trilogy");
    expect(book.seriesPosition).toBe(2);
    expect(book.seriesManual).toBe(false);
  });

  it("leaves series null when the title has no series suffix", async () => {
    const result = await createBookWithCopyData({
      title: "Test Books No Series Suffix Here",
      author: "Someone",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });

    if ("error" in result) throw new Error(result.error);
    const book = await prisma.book.findUniqueOrThrow({ where: { id: result.bookId } });
    expect(book.seriesName).toBeNull();
    expect(book.seriesPosition).toBeNull();
  });
```

Add one equivalent test to `src/lib/ownedPhysicalSync.test.ts` (shelf item with a series-suffixed title → created Book has the fields populated) and one to `src/lib/absSync.test.ts` (ABS item with a series-suffixed title → created Book has them). Match each file's existing mocking convention — read the neighbouring tests rather than inventing a new helper.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- books.test.ts` etc. Expected: `seriesName` is null where a value is expected.

- [ ] **Step 3: Implement**

In each of the three files, add the import:

```ts
import { parseSeriesFromTitle } from "@/lib/series";
```

**`src/lib/books.ts`** — in `createBookWithCopyData`, at the `prisma.book.create` around line 127:

```ts
  const series = parseSeriesFromTitle(title);

  const book = await prisma.book.create({
    data: {
      title,
      author: input.author.trim() || null,
      isbn,
      // seriesManual stays false: this is a derived value, not a hand-edit.
      seriesName: series?.seriesName ?? null,
      seriesPosition: series?.seriesPosition ?? null,
      copies: { create: copyData },
    },
  });
```

**`src/lib/absSync.ts`** — `createBookForItem` has two `prisma.book.create` calls (ebook and audiobook). Compute once at the top of the function and spread into both:

```ts
async function createBookForItem(item: AbsBookItem, mediaType: AbsMediaType): Promise<SyncBook> {
  const series = parseSeriesFromTitle(item.title);
  const seriesFields = {
    seriesName: series?.seriesName ?? null,
    seriesPosition: series?.seriesPosition ?? null,
  };

  if (mediaType === "EBOOK") {
    return prisma.book.create({
      data: {
        title: item.title,
        author: item.author,
        isbn: item.isbn,
        ...seriesFields,
        hasEbook: true,
        // ...rest unchanged...
```

Apply the same `...seriesFields` to the audiobook branch. Do not otherwise restructure the function.

**`src/lib/ownedPhysicalSync.ts`** — at the `prisma.book.create` around line 119:

```ts
  const series = parseSeriesFromTitle(item.title);
  const created = await prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      isbn: item.isbn,
      seriesName: series?.seriesName ?? null,
      seriesPosition: series?.seriesPosition ?? null,
      copies: { create: { format: "OTHER" } },
    },
    select: CANDIDATE_SELECT,
  });
```

- [ ] **Step 4: Verify**

Run: `npm test` — full suite.

- [ ] **Step 5: Commit**

```bash
git add src/lib/books.ts src/lib/absSync.ts src/lib/ownedPhysicalSync.ts src/lib/books.test.ts src/lib/absSync.test.ts src/lib/ownedPhysicalSync.test.ts
git commit -m "feat: parse series from title at every book-creation site"
```

---

### Task 4: Editing series on the edit page

**Files:**
- Modify: `src/lib/books.ts` (add `updateSeriesData`)
- Modify: `src/lib/actions/books.ts` (add `updateSeries`)
- Modify: `src/app/books/[id]/edit/EditBookForm.tsx`
- Test: `src/lib/books.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("updateSeriesData", () => {
  it("sets both fields and marks them manual", async () => {
    const book = await prisma.book.create({ data: { title: "Test Books Series Edit" } });

    const result = await updateSeriesData(book.id, { seriesName: "Hand Typed Series", seriesPosition: "3" });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.seriesName).toBe("Hand Typed Series");
    expect(updated.seriesPosition).toBe(3);
    expect(updated.seriesManual).toBe(true);
  });

  it("accepts a decimal position", async () => {
    const book = await prisma.book.create({ data: { title: "Test Books Series Decimal" } });

    await updateSeriesData(book.id, { seriesName: "Novella Series", seriesPosition: "2.5" });

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.seriesPosition).toBe(2.5);
  });

  it("clears both fields when given empty input, but stays manual", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Books Series Clear",
        seriesName: "Old Series",
        seriesPosition: 1,
        seriesManual: true,
      },
    });

    await updateSeriesData(book.id, { seriesName: "", seriesPosition: "" });

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.seriesName).toBeNull();
    expect(updated.seriesPosition).toBeNull();
    // Once hand-edited, always hand-edited -- matches readStatusManual/ratingManual.
    expect(updated.seriesManual).toBe(true);
  });

  it("allows a series name with no position", async () => {
    const book = await prisma.book.create({ data: { title: "Test Books Series No Position" } });

    await updateSeriesData(book.id, { seriesName: "Unnumbered Series", seriesPosition: "" });

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.seriesName).toBe("Unnumbered Series");
    expect(updated.seriesPosition).toBeNull();
  });

  it("rejects a non-numeric position", async () => {
    const book = await prisma.book.create({ data: { title: "Test Books Series Bad Position" } });

    const result = await updateSeriesData(book.id, { seriesName: "S", seriesPosition: "abc" });

    expect(result).toEqual({ error: "Series position must be a number" });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.seriesName).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement `updateSeriesData` in `src/lib/books.ts`**

```ts
// Saving series by hand always sets seriesManual, including when clearing
// both fields -- "I deliberately removed this" is itself a hand-edit, and
// matches the readStatusManual/ratingManual convention where un-setting a
// value never silently hands control back to the sync.
//
// There is intentionally no "let parsing manage this again" control: unlike
// read status and rating, which really do keep changing on Goodreads, a
// title's series suffix is fixed at creation, so there would be nothing for
// un-setting the flag to resume.
export async function updateSeriesData(
  bookId: string,
  input: { seriesName: string; seriesPosition: string },
): Promise<{ ok: true } | { error: string }> {
  const seriesName = input.seriesName.trim();
  const rawPosition = input.seriesPosition.trim();

  let seriesPosition: number | null = null;
  if (rawPosition) {
    seriesPosition = Number(rawPosition);
    if (!Number.isFinite(seriesPosition)) {
      return { error: "Series position must be a number" };
    }
  }

  await prisma.book.update({
    where: { id: bookId },
    data: {
      seriesName: seriesName || null,
      seriesPosition,
      seriesManual: true,
    },
  });

  return { ok: true };
}
```

- [ ] **Step 4: Add the `updateSeries` action to `src/lib/actions/books.ts`**

Mirror the existing `updateBook` action exactly, including its `revalidatePath` set — the detail page's series section depends on this data, so it must be revalidated:

```ts
export async function updateSeries(
  bookId: string,
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const result = await updateSeriesData(bookId, {
    seriesName: (formData.get("seriesName") as string) ?? "",
    seriesPosition: (formData.get("seriesPosition") as string) ?? "",
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}/edit`);
}
```

Import `updateSeriesData` alongside the existing `updateBookData` import.

**Also revalidate sibling detail pages?** No — a sibling's page is a separate route whose content changed, but `revalidatePath` per sibling would require querying them here. The pages are `dynamic = "force-dynamic"` where it matters; verify in Task 6 that a sibling page reflects a change without a manual refresh, and if it does not, report it rather than adding speculative revalidation now.

- [ ] **Step 5: Add the fields to `EditBookForm.tsx`**

**In `EditBookForm`, not `BookFormFields`** — the latter is shared with `/books/new`.

The component currently renders one `<form>` bound to `updateBook`. Add a second, separate `<form>` bound to `updateSeries` below it, so saving series is independent of saving title/author/isbn (matching how this page already keeps concerns in separate forms). Add the two props and wire them:

```tsx
interface EditBookFormProps {
  bookId: string;
  defaultTitle: string;
  defaultAuthor: string;
  defaultIsbn: string;
  defaultSeriesName: string;
  defaultSeriesPosition: string;
}
```

```tsx
  const updateSeriesWithId = updateSeries.bind(null, bookId);
  const [seriesState, seriesAction, isSeriesPending] = useActionState(
    updateSeriesWithId,
    initialState,
  );
```

```tsx
      <form action={seriesAction} className="mt-6 space-y-4">
        <h2 className="font-display text-lg font-medium text-foreground-strong">Series</h2>
        <div>
          <label htmlFor="seriesName" className="block text-sm font-medium text-foreground">
            Series name
          </label>
          <input
            id="seriesName"
            name="seriesName"
            defaultValue={defaultSeriesName}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="seriesPosition" className="block text-sm font-medium text-foreground">
            Position in series
          </label>
          <input
            id="seriesPosition"
            name="seriesPosition"
            type="number"
            step="0.5"
            defaultValue={defaultSeriesPosition}
            className={fieldClass}
          />
        </div>
        {seriesState.error && <p className="text-sm text-red-600">{seriesState.error}</p>}
        <Button type="submit" disabled={isSeriesPending} className="w-full">
          {isSeriesPending ? "Saving..." : "Save series"}
        </Button>
      </form>
```

`fieldClass` is currently defined inside `BookFormFields`. Copy the same string into `EditBookForm` as a local constant so the new inputs match — do **not** export it from `BookFormFields` and do not restructure that component.

- [ ] **Step 6: Pass the new props from the edit page**

In `src/app/books/[id]/edit/page.tsx`, pass the book's current values, converting the nullable number to a string for the input:

```tsx
        defaultSeriesName={book.seriesName ?? ""}
        defaultSeriesPosition={book.seriesPosition?.toString() ?? ""}
```

- [ ] **Step 7: Verify**

Run: `npm test`, then `npm run build`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/books.ts src/lib/books.test.ts src/lib/actions/books.ts "src/app/books/[id]/edit/EditBookForm.tsx" "src/app/books/[id]/edit/page.tsx"
git commit -m "feat: add series fields to the book edit page"
```

---

### Task 5: The "Part of" section on the detail page

**Files:**
- Modify: `src/app/books/[id]/page.tsx`
- Test: `src/lib/series.test.ts` (for the ordering helper)

The ordering rule is non-trivial (position ascending, nulls last, title tiebreak), so it goes in a pure exported helper that can be tested directly rather than being buried in JSX.

- [ ] **Step 1: Write the failing test for the ordering helper**

Add to `src/lib/series.test.ts`:

```ts
import { sortSeriesMembers } from "@/lib/series";

describe("sortSeriesMembers", () => {
  const m = (title: string, seriesPosition: number | null) => ({ id: title, title, seriesPosition });

  it("orders by position ascending", () => {
    expect(sortSeriesMembers([m("C", 3), m("A", 1), m("B", 2)]).map((x) => x.title)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("sorts books with no position after every book that has one", () => {
    expect(sortSeriesMembers([m("NoPos", null), m("First", 1)]).map((x) => x.title)).toEqual([
      "First",
      "NoPos",
    ]);
  });

  it("breaks ties on title", () => {
    expect(sortSeriesMembers([m("Zebra", 1), m("Apple", 1)]).map((x) => x.title)).toEqual([
      "Apple",
      "Zebra",
    ]);
  });

  it("orders several null positions among themselves by title", () => {
    expect(sortSeriesMembers([m("Zebra", null), m("Apple", null)]).map((x) => x.title)).toEqual([
      "Apple",
      "Zebra",
    ]);
  });

  it("handles decimal positions", () => {
    expect(sortSeriesMembers([m("Two", 2), m("Novella", 1.5), m("One", 1)]).map((x) => x.title)).toEqual([
      "One",
      "Novella",
      "Two",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement the helper in `src/lib/series.ts`**

```ts
export interface SeriesMember {
  id: string;
  title: string;
  seriesPosition: number | null;
}

// Position ascending, with un-numbered entries after every numbered one and
// ties broken by title. Sorted here rather than in the query because "nulls
// last" ordering varies across Prisma versions, and a series is small enough
// that in-memory sorting costs nothing.
export function sortSeriesMembers<T extends SeriesMember>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    if (a.seriesPosition === null && b.seriesPosition === null) {
      return a.title.localeCompare(b.title);
    }
    if (a.seriesPosition === null) return 1;
    if (b.seriesPosition === null) return -1;
    if (a.seriesPosition !== b.seriesPosition) return a.seriesPosition - b.seriesPosition;
    return a.title.localeCompare(b.title);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Add the section to the detail page**

In `src/app/books/[id]/page.tsx`, after the `book` fetch and its `notFound()` guard:

```tsx
  // Case-insensitive so "The Daevabad Trilogy" and "the daevabad trilogy"
  // group together; no fuzzy matching, deliberately -- see the spec's
  // non-goals. Only queried when this book actually has a series.
  const seriesMembers = book.seriesName
    ? sortSeriesMembers(
        await prisma.book.findMany({
          where: { seriesName: { equals: book.seriesName, mode: "insensitive" } },
          select: { id: true, title: true, seriesPosition: true },
        }),
      )
    : [];
```

Render after the title/author/isbn header block, before the Copies section. Shown only when at least one *other* book shares the series — a series of one tells the reader nothing:

```tsx
      {seriesMembers.length > 1 && (
        <section className="mb-4">
          <h2 className="mb-2 font-display text-lg font-medium text-foreground-strong">
            Part of: {book.seriesName}
          </h2>
          <ol className="space-y-1 text-sm">
            {seriesMembers.map((member) => (
              <li key={member.id}>
                <span className="text-foreground/70">
                  {member.seriesPosition ?? "—"}.{" "}
                </span>
                {member.id === book.id ? (
                  <span className="text-foreground">
                    {member.title}{" "}
                    <span className="text-foreground/70">(this book)</span>
                  </span>
                ) : (
                  <Link href={`/books/${member.id}`} className="text-link underline">
                    {member.title}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
```

The current book is listed but not linked to itself.

- [ ] **Step 6: Verify**

Run: `npm test`, `npm run build`, `npm run lint` (expect no NEW findings; there is 1 pre-existing error in `CoverPicker.tsx` and 1 pre-existing warning in `actions/copies.ts`).

- [ ] **Step 7: Commit**

```bash
git add "src/app/books/[id]/page.tsx" src/lib/series.ts src/lib/series.test.ts
git commit -m "feat: show series siblings on the book detail page"
```

---

### Task 6: Browser verification

**Files:** none (verification only)

- [ ] **Step 1: Seed a series fixture into the isolated TEST database**

Never the shared dev DB. Include: three books in one series with positions 1, 1.5, 2; one book in that series with a **null** position; one book alone in its own series (to confirm the section is hidden); and one book with no series at all.

- [ ] **Step 2: Start a dev server against the test DB**

Inline `DATABASE_URL` override only — never edit `.env`/`.env.test`. Mint a session cookie with `iron-session`'s `sealData({ authenticated: true }, { password: SESSION_SECRET })` and set it via Playwright's `addCookies` (it is `httpOnly`, so `document.cookie` won't work).

- [ ] **Step 3: Confirm on the detail pages**

- A book in the multi-book series shows "Part of: …" listing all four, ordered 1, 1.5, 2, then the null-position one last.
- The current book is marked "(this book)" and is **not** a link; every sibling **is** a link and navigating to one works.
- The lone-series book shows **no** section.
- The no-series book shows **no** section.

- [ ] **Step 4: Confirm the edit round-trip**

Edit a book's series name and position, save, and confirm: the detail page reflects it immediately, the book now appears in the right series grouping, and `seriesManual` is `true` in the database.

Also edit a book's **title** and confirm its series fields are left untouched — the deliberate non-goal that a retitle does not re-derive series.

- [ ] **Step 5: Clean up**

Kill the dev server, delete every seeded row, and confirm zero remain. **Do this in the same step as the verification** — leftover scale/demo fixtures in `bookcatalog_test` have twice caused spurious failures in unrelated suites that scan whole tables.

- [ ] **Step 6: Final check**

Run `npm test` one more time after cleanup to confirm the suite is green against a clean database.
