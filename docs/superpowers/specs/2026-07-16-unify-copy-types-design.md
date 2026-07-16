# Unify Copy Types (EbookCopy/AudiobookCopy) — Design Spec

Date: 2026-07-16

## Purpose

Replace `Book.absEbookItemIds`/`Book.absAudiobookItemIds` (scalar string arrays) with real `EbookCopy`/`AudiobookCopy` tables, mirroring the existing `PhysicalCopy` table's shape. This is a foundational, no-user-visible-change phase: it exists so a later phase can attach a cover image (and potentially other per-item metadata) to an individual ebook or audiobook item, the same way `PhysicalCopy.coverImagePath` already works for physical copies — something the current array-of-IDs representation has no room for.

## Scope

- `Book` loses `absEbookItemIds`/`absAudiobookItemIds`; gains `ebookCopies`/`audiobookCopies` relations to two new tables.
- `Book.hasEbook`/`Book.hasAudiobook` are unchanged in meaning and stay as denormalized booleans, kept in sync exactly as today — no changes needed in `search.ts` or anywhere else that only reads these two flags.
- `src/lib/absSync.ts` is rewritten to create/delete real rows instead of pushing/filtering array entries. Its externally-observable behavior (matching logic, thresholds, stale-removal semantics, `hasEbook`/`hasAudiobook` correctness) is unchanged.
- `src/lib/duplicates.ts`'s `mergeBooksData` is updated to reassign `EbookCopy`/`AudiobookCopy` rows onto the kept book (same pattern already used for `PhysicalCopy`), instead of unioning arrays.
- **Data backfill happens inside the migration itself**: existing real `absEbookItemIds`/`absAudiobookItemIds` array entries in production are converted directly into `EbookCopy`/`AudiobookCopy` rows as part of the same migration that creates the tables and drops the array columns — no separate manual script, no window where links disappear, no dependency on the next sync run.
- No UI changes. No cover-image feature yet — that's the next phase, built on top of this one, once these tables exist to attach a `coverImagePath` to.

## Data Model

```prisma
model EbookCopy {
  id             String   @id @default(cuid())
  bookId         String
  book           Book     @relation(fields: [bookId], references: [id])
  absItemId      String
  coverImagePath String?
  createdAt      DateTime @default(now())
}

model AudiobookCopy {
  id             String   @id @default(cuid())
  bookId         String
  book           Book     @relation(fields: [bookId], references: [id])
  absItemId      String
  coverImagePath String?
  createdAt      DateTime @default(now())
}
```

Two separate tables (not one unified table with a type discriminator), matching the existing `hasEbook`/`hasAudiobook` split and the rest of the codebase's convention of treating ebook and audiobook ownership as distinct concerns that happen to be structurally similar. `coverImagePath` is included now (nullable) even though nothing writes to it yet in this phase — adding it later would be a second migration for no reason, and its presence here doesn't add any behavior on its own.

`Book` changes:
- Removed: `absEbookItemIds String[] @default([])`, `absAudiobookItemIds String[] @default([])`.
- Added: `ebookCopies EbookCopy[]`, `audiobookCopies AudiobookCopy[]` (relation fields, no new columns on `Book` itself).
- Unchanged: `hasEbook Boolean @default(false)`, `hasAudiobook Boolean @default(false)`, `lastAbsSyncedAt DateTime?`.

## Migration & Backfill

One migration, in this order (all inside the same `migration.sql`, applied atomically by `prisma migrate deploy`):

1. `CREATE TABLE "EbookCopy" (...)` and `CREATE TABLE "AudiobookCopy" (...)`, with foreign keys to `Book`.
2. Backfill: for every `Book` row, explode `absEbookItemIds`/`absAudiobookItemIds` via Postgres' `unnest()` into one `INSERT` per array element, e.g. (illustrative, exact SQL finalized during implementation):
   ```sql
   INSERT INTO "EbookCopy" ("id", "bookId", "absItemId", "createdAt")
   SELECT gen_random_uuid()::text, "Book"."id", item, "Book"."lastAbsSyncedAt"
   FROM "Book", unnest("Book"."absEbookItemIds") AS item
   WHERE array_length("Book"."absEbookItemIds", 1) > 0;
   ```
   (and the equivalent for `AudiobookCopy`/`absAudiobookItemIds`). `gen_random_uuid()` is used for these backfilled rows' ids rather than Prisma's application-level `cuid()` generator (which isn't available inside a raw SQL migration) — this is safe, since nothing in the schema or application code validates the *format* of an existing id, only that it's a unique string primary key. Every row created by the application from this point forward still gets a real `cuid()` via Prisma Client as normal.
3. Drop `absEbookItemIds`/`absAudiobookItemIds` columns from `Book`.

`hasEbook`/`hasAudiobook` are untouched by this migration — they already correctly reflect ownership from before, and nothing about the backfill changes which books are considered to own an ebook/audiobook.

## `absSync.ts` Changes

The overall algorithm is unchanged in shape (fetch ABS items → fast-path skip for already-linked items → fuzzy-match-or-create for new items → remove stale links at the end); only the storage mechanism changes:

- **Fast-path "already linked" lookup**: previously built from `books.flatMap(b => b.absEbookItemIds)`; now queries `EbookCopy`/`AudiobookCopy` directly for their `absItemId`s into the same `Set<string>` shape — same O(1) membership check, same performance characteristics, different source table.
- **First-time fuzzy match / create**: `linkItemToExistingBook` creates one `EbookCopy`/`AudiobookCopy` row (`{ bookId, absItemId }`) instead of pushing onto an array, and sets `hasEbook`/`hasAudiobook: true` plus `lastAbsSyncedAt` on the `Book` in the same transaction. `createBookForItem` creates the new `Book` with its first copy row nested via Prisma's relation `create`, analogous to how `createBookWithCopyData` nests a `PhysicalCopy` under a new `Book` today.
- **Stale-link removal**: previously filtered each book's arrays down to items still seen this pass, updating or deleting the `Book`. Now deletes the `EbookCopy`/`AudiobookCopy` rows whose `absItemId` wasn't in this pass's seen set, then recomputes `hasEbook`/`hasAudiobook` per affected book from the post-deletion row counts (true if any rows remain), and deletes the `Book` entirely if it ends up with zero ebook copies, zero audiobook copies, and zero physical copies — the exact same cleanup rule as today, now driven by real row counts instead of array lengths. The existing per-media-type guard (only prune a media type if at least one item of that type was actually fetched this pass, protecting against a misconfigured/renamed ABS library wiping real data) is preserved unchanged in intent.
- Matching logic itself (`findBestTitleMatch`, `DEFAULT_MATCH_THRESHOLD`) is completely untouched.

## `duplicates.ts` Changes

`mergeBooksData` currently unions `absEbookItemIds`/`absAudiobookItemIds` arrays from the merged books onto the kept book. This becomes a row **reassignment**, identical in spirit to how `PhysicalCopy` rows are already reassigned in this same function:

```typescript
prisma.ebookCopy.updateMany({ where: { bookId: { in: mergeIds } }, data: { bookId: keepId } }),
prisma.audiobookCopy.updateMany({ where: { bookId: { in: mergeIds } }, data: { bookId: keepId } }),
```

`hasEbook`/`hasAudiobook` on the kept book are recomputed from the post-reassignment row counts (true if any rows exist), replacing the current OR-of-input-flags logic — consistent with the same "derive from real rows, don't trust a possibly-stale stored flag" principle a recent Copilot review already established for this exact function.

`findDuplicateBookGroups`'s reported `hasEbook`/`hasAudiobook` per candidate are unaffected in meaning (still "does this book have any ebook/audiobook ownership"), just backed by the new tables.

## Testing

- **`prisma/migrations/.../migration.sql`**: no automated test (migrations aren't unit-tested in this project), but manually verified during implementation by running the migration against a snapshot of real data shape and confirming row counts match the pre-migration array lengths exactly (sum of `EbookCopy`/`AudiobookCopy` rows per book equals the corresponding array's length beforehand).
- **`src/lib/absSync.test.ts`**: existing tests are rewritten to assert against `EbookCopy`/`AudiobookCopy` rows instead of array contents; all existing scenarios (fast-path, fuzzy match, create, two-editions-linking-to-one-book, partial-type removal, full removal + delete, kept-with-physical-copy) carry over with the same intent, just different assertions.
- **`src/lib/duplicates.test.ts`**: the "unions ebook/audiobook flags and item ids" test is rewritten to assert real rows were reassigned (`bookId` updated) rather than array contents unioned.
- **Live verification** (matching every prior phase's pattern): after deploying, confirm the real production `Book` rows' ebook/audiobook ownership is unchanged after the migration runs (spot-check a few books that had non-empty arrays before), then trigger a real ABS sync and confirm it still links/creates/removes correctly against the new tables.

## Non-Goals

- No cover-image upload/display/editing UI yet — this phase only creates the place (`coverImagePath` columns) a later phase will write to and read from.
- No change to `hasEbook`/`hasAudiobook`'s meaning, `search.ts`'s filter logic, or any other reader of those two flags.
- No change to physical copies, `PhysicalCopy`, or the scan/manual-add flows.
- No change to `absSync.ts`'s matching thresholds, library-name detection, or fuzzy-match logic itself — only how a match's ownership gets persisted.
