# Personal Library Catalog — Design Spec

Date: 2026-07-05

## Purpose

A mobile-friendly, self-hosted web app for quickly checking whether a book is
already owned, in what format(s), and (for physical copies) which specific
edition. Unifies two existing sources:

- **Ebooks/audiobooks** — already in Audiobookshelf (ABS), across the "Panda
  EBooks" and "Panda Audiobooks" libraries.
- **Physical books** — newly tracked in this app directly (replacing
  Goodreads for inventory purposes; Goodreads can still be used separately
  for reading history/reviews if desired, but is not a data source here).

It also surfaces a **TBR gap view**: books on the user's Goodreads "to-read"
shelf that aren't owned in any format (physical, ebook, or audiobook) —
i.e., books they want to read but haven't yet acquired.

Goodreads and Libib were both considered for the physical-book side. Neither
offers a live read API for personal catalogs (Libib's REST API is
patron/circulation-only; LibraryThing has no personal-catalog API due to
data-licensing restrictions) — both require manual CSV export. Given that
limitation exists regardless of provider, and the user wants live barcode
scanning plus multi-copy/edition tracking without a manual export step, this
spec builds a small custom app rather than depending on a third-party
service.

## Non-goals

- No multi-user accounts — single shared password, matching household use.
- No reading-progress tracking, ratings, or reviews (that's Goodreads' job,
  if the user keeps using it for that).
- No condition/shelf-location tracking for physical copies (explicitly out
  of scope per user).
- No live ABS or Goodreads querying on every search/view — both are cached
  and refreshed periodically (see Sync Jobs).

## Architecture

A single Next.js (App Router) application, deployed as a Docker container
alongside the existing Audiobookshelf instance on the same host, backed by a
PostgreSQL container.

- **Frontend**: one mobile-friendly page — a search bar for the "do I own
  this?" check, and an "Add a book" flow with camera-based barcode scanning.
- **Backend**: Next.js API routes handle catalog CRUD, ISBN metadata lookups
  (server-side proxy to Open Library, avoiding browser CORS issues), and the
  ABS and Goodreads cache sync jobs.
- **Auth**: a login page gating the whole app behind a single shared
  password.
- **Barcode scanning**: client-side, via `@zxing/library` decoding the phone
  camera's video feed (through `getUserMedia`) for EAN-13 (ISBN) barcodes.
  Chosen over the native `BarcodeDetector` API because it works consistently
  across both iOS Safari and Android Chrome, whereas `BarcodeDetector`
  support is inconsistent on iOS.

## Data Model

Three tables (Prisma schema, PostgreSQL):

```prisma
model Book {
  id        String         @id @default(cuid())
  title     String
  author    String?
  isbn      String?
  createdAt DateTime       @default(now())
  copies    PhysicalCopy[]
}

model PhysicalCopy {
  id             String   @id @default(cuid())
  bookId         String
  book           Book     @relation(fields: [bookId], references: [id])
  format         Format
  publisher      String?
  publishYear    Int?
  specialNotes   String?
  coverImagePath String?
  createdAt      DateTime @default(now())
}

enum Format {
  HARDCOVER
  PAPERBACK
  MASS_MARKET
  OTHER
}

model AbsCacheItem {
  id           String   @id @default(cuid())
  absItemId    String   @unique
  title        String
  author       String?
  isbn         String?
  mediaType    MediaType
  lastSyncedAt DateTime @default(now())
}

enum MediaType {
  EBOOK
  AUDIOBOOK
}

model GoodreadsTbrItem {
  id           String   @id @default(cuid())
  title        String
  author       String?
  isbn         String?
  lastSyncedAt DateTime @default(now())
}
```

Notes:

- One `PhysicalCopy` row per physical copy owned — two copies of the same
  edition are two rows, not a quantity field. This lets per-copy notes
  (e.g., "this one's signed") attach to just one copy.
- `AbsCacheItem.mediaType` is derived from which ABS library
  (Panda EBooks vs. Panda Audiobooks) the item came from during sync.
- `GoodreadsTbrItem` mirrors the shape of the existing Goodreads RSS fetch
  (title/author/isbn), refreshed the same way as `AbsCacheItem` (see Sync
  Jobs).
- Matching "is this the same book" across `Book`/`PhysicalCopy`,
  `AbsCacheItem`, and `GoodreadsTbrItem` is NOT stored — it's computed on
  the fly using the fuzzy-title-matching logic ported from the existing
  `audiobook-compare/compare_audiobooks.py` (`normalize_title`,
  `_title_forms`, series/subtitle stripping), translated from Python to
  TypeScript. That logic is already tuned against this user's real
  Goodreads/ABS data and should not be reinvented.

## Add-Book Flow (Barcode Scanning + Cover Capture)

1. User taps "Add a book," which opens the phone camera via `getUserMedia`.
2. `@zxing/library` continuously scans the video feed for an EAN-13 barcode.
3. On decode, two things happen in parallel:
   - The app grabs a still frame from the current video feed as the
     default cover photo (capturing the user's actual physical copy).
   - The decoded ISBN is sent to a backend route that queries the Open
     Library Books API (`https://openlibrary.org/api/books`) for title,
     author, publisher, and publish year, plus fetches Open Library's own
     cover image (`covers.openlibrary.org`) as an alternative/fallback
     cover.
4. The user is shown a pre-filled form: title, author, publisher, publish
   year, and both candidate cover images (captured photo vs. Open Library
   cover) to choose between (or retake the photo). They pick a `Format`
   from a dropdown and may add free-text `specialNotes`.
5. On save:
   - If an existing `Book` matches by ISBN, or by fuzzy title/author match
     if ISBN is missing/absent, a new `PhysicalCopy` row is attached to it.
   - Otherwise, a new `Book` + `PhysicalCopy` are created together.
   - The chosen cover image is saved to a mounted disk volume
     (`/app/uploads`, alongside the Postgres data volume) and its path
     stored in `coverImagePath`.
6. A "scan another" shortcut returns to step 1 immediately, so adding a
   stack of books in one sitting doesn't require re-navigating each time.

### Error handling

- **Open Library has no data for the scanned ISBN** (common for
  small-press/older books): the form still opens, pre-filled with nothing
  but the ISBN and the captured cover photo; user fills in title/author/etc.
  manually.
- **No barcode / camera denied**: a "manual entry" link on the Add screen
  skips scanning entirely, opening the same form empty (no cover photo
  captured — Open Library cover, if any, is still fetched once an ISBN is
  typed in manually).
- **Same ISBN scanned twice in one session**: treated as adding a second
  copy, not an error — this is the expected multi-copy path.

## Search / Lookup Page

A single search box. On input, the app queries in parallel:

- `Book` + `PhysicalCopy` (via simple `ILIKE` matches on title/author/isbn —
  full-text search infrastructure is unnecessary at personal-library scale).
- `AbsCacheItem` (same approach).

Results are merged per-book using the ported fuzzy-matching logic, so a
search for "Mistborn" returns one entry: cover thumbnail, "Physical
(paperback, Tor 2010)", "Ebook ✓", "Audiobook ✓" — rather than three
disconnected rows. Tapping an entry with multiple physical copies expands to
show each copy's format/publisher/notes/cover individually.

## TBR Gap View

A separate page/tab (distinct from the search box, since it's a browseable
list rather than a lookup) listing every `GoodreadsTbrItem` that does NOT
fuzzy-match any entry in `Book`/`PhysicalCopy` or `AbsCacheItem` — i.e.,
books on the user's "to-read" shelf not yet owned in any format. This
reuses the same matching logic as the search page, just inverted: instead
of "find what I own," it's "find what's on my TBR with no match in what I
own." Each entry shows title/author so the user can quickly decide whether
to buy/borrow it.

## Sync Jobs

Two `node-cron` jobs inside the Next.js server process itself (no separate
cron container — the Next.js standalone server is already a long-running
process), each running every 30–60 minutes:

**ABS sync:**

1. `GET /api/libraries` on the ABS instance, filtered to "Panda EBooks" and
   "Panda Audiobooks" (same approach as `audiobook-compare/list_libraries.py`).
2. For each library, paginate `GET /api/libraries/:id/items` (same approach
   as `compare_audiobooks.py`'s `fetch_abs_library_items`).
3. Upsert each item into `AbsCacheItem`, keyed on `absItemId`, setting
   `mediaType` from which library it came from and updating
   `lastSyncedAt`.

**Goodreads TBR sync:**

1. Fetch the public "to-read" shelf RSS feed
   (`https://www.goodreads.com/review/list_rss/{user_id}?shelf=to-read`),
   paginating the same way as `compare_audiobooks.py`'s
   `fetch_all_goodreads_books`, ported to TypeScript.
2. Replace the contents of `GoodreadsTbrItem` with the fetched set (a full
   replace rather than an upsert-by-id, since Goodreads RSS doesn't expose
   a stable per-item id to key on — books removed from the shelf should
   disappear from the gap view too).

A manual "refresh now" button in the UI triggers both sync routes
on-demand (useful right after a big upload batch or after editing Goodreads
shelves, so the catalog/TBR view reflects changes immediately instead of
waiting for the next scheduled run).

**Error handling**: if ABS or Goodreads is unreachable during a sync run,
that job logs the failure and leaves its existing cache untouched (stale
data is preferable to wiping the cache on a transient network blip). The
manual refresh button surfaces the error to the user directly if triggered
interactively.

## Auth & Deployment

- **Auth**: a login page compares the submitted password against a bcrypt
  hash stored in an env var (`APP_PASSWORD_HASH`). On success, a signed
  HTTP-only session cookie is set. Next.js middleware gates every route
  except `/login` behind a valid session. No multi-user accounts.
- **Deployment**: two Docker services alongside the existing ABS setup —
  the Next.js app (standalone build) and a PostgreSQL container, sharing a
  Docker network. Persistent volumes for the Postgres data directory and
  the `/app/uploads` cover-image folder. Configuration
  (`DATABASE_URL`, `ABS_URL`, `ABS_TOKEN`, `APP_PASSWORD_HASH`,
  `SESSION_SECRET`) lives in a `.env` file, matching the pattern already
  used in `audiobook-compare/.env`.

## Testing

- **Fuzzy-matching port**: since this is a direct port of already-tested
  Python logic (`compare_audiobooks.py` has existing tests), the TypeScript
  port should carry over equivalent unit tests (title normalization,
  series-suffix stripping, cross-form matching) to confirm behavior parity.
- **API routes**: unit/integration tests for the ISBN lookup proxy (mocking
  Open Library responses, including the "no data found" case), the ABS
  sync upsert logic (mocking ABS API responses, including pagination and
  the unreachable-instance case), and the Goodreads TBR sync (mocking the
  RSS feed, including the empty-shelf and non-XML-response cases already
  covered in `compare_audiobooks.py`'s existing tests).
- **Barcode scanning / camera**: not practical to unit test (hardware- and
  browser-dependent) — verified manually on both an iOS and an Android
  device during implementation.
- **Manual QA checklist**: add a book via scan (with and without Open
  Library data), add a book manually, add a second copy of an existing
  book, search and confirm merged results across physical/ebook/audiobook,
  trigger manual ABS/Goodreads refresh, confirm the TBR gap view excludes
  books owned in any format and includes ones that aren't, log in/out.
