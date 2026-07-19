import { XMLParser } from "fast-xml-parser";
import type { ReadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeIsbn as normalizeIsbnShared } from "@/lib/books";
import { findBestTitleMatch, normalizeTitle } from "@/lib/matching";
import { deleteCoverImage } from "@/lib/coverStorage";
import { lookupIsbn } from "@/lib/isbnLookup";
import { saveCoverFromUrl } from "@/lib/books";

export interface GoodreadsBook {
  title: string;
  author: string | null;
  isbn: string | null;
  rating: number | null;
}

export type GoodreadsShelf = "to-read" | "currently-reading" | "read";

const MAX_PAGES = 100; // matches the audiobook-compare reference script's cap

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

function normalizeIsbn(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  const normalized = normalizeIsbnShared(s);
  return normalized || null;
}

// Goodreads' per-shelf RSS feed includes <user_rating>, an integer 0-5 where
// 0 means "not rated" -- confirmed against a real feed during design (see
// docs/superpowers/specs/2026-07-15-read-status-ratings-design.md). Mapped
// to null (not 0) to match Book.rating's own null-means-unrated convention,
// and constrained to the same 1-5 range Book.rating expects -- anything
// outside it (feed corruption, an unexpected future format change) is
// treated as null rather than persisted, since a stray out-of-range value
// would otherwise propagate into the DB and could break UI code that
// assumes a 1-5 range (e.g. ratingStars()'s repeat-count math).
function parseRating(raw: unknown): number | null {
  const n = typeof raw === "string" ? parseInt(raw, 10) : typeof raw === "number" ? raw : 0;
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

export async function fetchGoodreadsPage(
  userId: string,
  shelf: string,
  page: number,
): Promise<GoodreadsBook[]> {
  const url = new URL(`https://www.goodreads.com/review/list_rss/${userId}`);
  url.searchParams.set("shelf", shelf);
  url.searchParams.set("per_page", "200");
  url.searchParams.set("page", String(page));

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Goodreads for shelf "${shelf}" page ${page}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Goodreads shelf "${shelf}" page ${page}: HTTP ${response.status}`,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new Error(
      `Failed to read Goodreads response body for shelf "${shelf}" page ${page}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed;
  try {
    parsed = parser.parse(text);
  } catch {
    throw new Error(
      `Goodreads returned non-XML on shelf "${shelf}" page ${page} (first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  if (parsed?.rss === undefined) {
    throw new Error(
      `Goodreads returned an unexpected response shape on shelf "${shelf}" page ${page} (missing <rss> root; first 200 chars: ${text.slice(0, 200)})`,
    );
  }

  const rawItems = parsed.rss.channel?.item;
  if (!rawItems) return [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  const books: GoodreadsBook[] = [];
  for (const item of items) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title) continue;
    const author =
      typeof item.author_name === "string" && item.author_name.trim()
        ? item.author_name.trim()
        : null;
    const isbn = normalizeIsbn(item.isbn13) ?? normalizeIsbn(item.isbn);
    const rating = parseRating(item.user_rating);
    books.push({ title, author, isbn, rating });
  }
  return books;
}

export async function fetchAllGoodreadsBooks(
  userId: string,
  shelf: string,
): Promise<GoodreadsBook[]> {
  const allBooks: GoodreadsBook[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const books = await fetchGoodreadsPage(userId, shelf, page);
    if (books.length === 0) break;
    allBooks.push(...books);
    if (page === MAX_PAGES) {
      console.warn(
        `Goodreads sync hit the ${MAX_PAGES}-page cap for user ${userId} shelf "${shelf}" with page ${MAX_PAGES} still non-empty — results may be truncated.`,
      );
    }
  }
  return allBooks;
}

// Shelves are processed in this fixed order: to-read, currently-reading,
// read. A book present on more than one shelf in the same sync (atypical on
// Goodreads but possible) ends up with whichever status/rating its
// LAST-processed shelf implies -- read wins over currently-reading, which
// wins over to-read -- per the design spec.
const STATUS_SYNC_SHELVES: GoodreadsShelf[] = ["to-read", "currently-reading", "read"];

const SHELF_READ_STATUS: Record<GoodreadsShelf, ReadStatus> = {
  "to-read": "TO_READ",
  "currently-reading": "READING",
  read: "READ",
};

interface StatusSyncBook {
  id: string;
  title: string;
  readStatus: ReadStatus | null;
  readStatusManual: boolean;
  rating: number | null;
  ratingManual: boolean;
}

const STATUS_SYNC_BOOK_SELECT = {
  id: true,
  title: true,
  readStatus: true,
  readStatusManual: true,
  rating: true,
  ratingManual: true,
} as const;

// Applies one shelf's items onto already-owned Book rows only -- a shelf
// item with no matching Book is ignored; this phase never creates a Book
// from Goodreads shelf data. Each field's manual-override flag is respected
// independently: a manually-set readStatus is left alone even while rating
// still gets synced for that same Book, and vice versa.
async function applyShelfToBooks(
  shelf: GoodreadsShelf,
  items: GoodreadsBook[],
  books: StatusSyncBook[],
): Promise<void> {
  const targetStatus = SHELF_READ_STATUS[shelf];

  for (const item of items) {
    const match = findBestTitleMatch(books, item.title);
    if (!match) continue;

    const data: { readStatus?: ReadStatus; rating?: number } = {};
    if (!match.readStatusManual && match.readStatus !== targetStatus) {
      data.readStatus = targetStatus;
    }
    if (!match.ratingManual && item.rating !== null && match.rating !== item.rating) {
      data.rating = item.rating;
    }
    if (Object.keys(data).length === 0) continue;

    const updated = await prisma.book.update({
      where: { id: match.id },
      data,
      select: STATUS_SYNC_BOOK_SELECT,
    });
    // `match` is the actual element findBestTitleMatch found inside `books`
    // (not a copy), so mutating it in place keeps the in-memory list
    // consistent with the DB for later shelf passes -- no re-scan needed,
    // and no risk of a stale `findIndex` miss silently no-op'ing (assigning
    // to `books[-1]`) the way a second array search could.
    Object.assign(match, updated);
  }
}

interface ExistingTbrItem {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  coverImagePath: string | null;
}

// Reconciles the "to-read" shelf against existing GoodreadsTbrItem rows
// instead of the old delete+recreate approach -- a full replace would
// destroy any fetched cover (coverImagePath/coverCheckedAt) every single
// sync cycle, since Goodreads' RSS feed exposes no stable per-item id to
// upsert on directly. Matches by exact ISBN first (O(1) via existingByIsbn),
// falling back to fuzzy title matching (findBestTitleMatch, already used
// elsewhere in this codebase for the same "match incoming data to existing
// rows with no shared stable id" problem) for anything that doesn't
// ISBN-match.
//
// The fuzzy fallback tries a cheap exact-title check across the full pool
// FIRST, only falling back to real fuzzy scoring (findBestTitleMatch) when
// that finds nothing -- this caused a real production CPU incident when it
// was just "always fuzzy-match" (confirmed empirically: fuzzy-matching 80
// isbn-less shelf items against a full ~800-row pool took 4.5s of
// synchronous, single-threaded work on a fast dev machine, run every 30
// minutes on the same process serving the app's own HTTP requests, on a
// resource-constrained single-core VPS also hosting Audiobookshelf -- CPU
// pegged solid enough that the ABS process starved too). Goodreads' RSS feed
// regularly omits isbn for a meaningful fraction of shelf items (confirmed
// via this file's own "Mistborn" test fixture), so isbn-less items needing
// this fallback are the COMMON case, not an edge case.
//
// The fix is NOT restricting which rows get scanned (an earlier version
// tried an isbn-less-only candidate pool, and that version's own attempt to
// stay correct -- trusting a tier-1 match only above some score threshold --
// was caught in code review reintroducing data loss: titleMatchScore takes
// the max over EVERY titleForms() variant, including a colon-split prefix,
// so two DIFFERENT books sharing a series name before a colon (e.g.
// "Mistborn: The Final Empire" vs "Mistborn: The Well of Ascension") score
// a perfect 100 against each other despite not being the same book at all --
// no score threshold on a restricted pool is safe). The fix is restricting
// WHICH KIND of comparison runs against the full pool:
//
// - Cheap pass (tried first): a literal `normalizeTitle` string-equality
//   lookup against the ENTIRE remaining pool, via a Map keyed by normalized
//   title (existingByNormalizedTitle, built once up front, alongside
//   existingByIsbn) -- ordinary string comparison, not titleForms()'s
//   multi-variant fuzzy scoring, so it can't produce the colon-prefix false
//   positive above (two different titles are never string-equal after
//   normalization just because they share a substring). Precomputing the
//   map (rather than calling normalizeTitle() fresh inside a linear scan
//   for every shelf item) turns this into an O(1) lookup per shelf item
//   after one O(existing.length) setup pass, instead of O(pool) per shelf
//   item -- both are far cheaper than fuzzy scoring at any scale, since
//   string equality skips the expensive Ratcliff/Obershelp matching-blocks
//   algorithm entirely, but the map avoids even the cheap version's
//   redundant re-normalization. Considering the FULL pool here (not an
//   isbn-less-only subset) matters too: restricting it could miss a
//   literal title match sitting on the isbn-bearing side.
// - Fuzzy pass (only reached when the cheap pass finds nothing): identical
//   to the original single-pool implementation -- scans the same full
//   remaining pool with findBestTitleMatch, guaranteed to find the single
//   true global-best candidate. Its cost is bounded by how often a shelf
//   item ISN'T a literal, unchanged repeat of something already in the
//   table (genuinely new additions, or a title that changed cosmetically),
//   not by table size.
//
// Two correctness bugs already lived in earlier versions of this function:
// (1) two incoming shelf items sharing one ISBN would both match the same
// existing row, silently dropping one book (last-write-wins, no error,
// since isbn has no unique constraint) -- fixed by the matchedIds re-check
// on the ISBN branch below, independent of which pass below it resolves in;
// (2) an existing row WITH an isbn was permanently unreachable once its
// incoming isbn stopped matching -- fixed by always falling through to a
// full-pool pass (cheap-exact then fuzzy) rather than a restricted one. Both
// the CPU incident (a full fuzzy scan on every fallback) and the
// reintroduced data-loss bug (a restricted, score-thresholded fuzzy pool)
// were real; this cheap-exact-then-fuzzy-on-full-pool shape is what fixes
// both without reintroducing the other.
//
// A shelf item with no match gets a fresh row; an existing row matched to
// nothing on the current shelf (removed from Goodreads) gets deleted, with
// its cover file cleaned up first -- same pattern as PR #19's orphaned-cover
// cleanup.
//
// Runs as sequential individual Prisma calls, not one large transaction --
// deliberately avoiding the kind of long-held-transaction/connection-pool
// risk that caused the PR #17 production incident (Prisma P2028, "Unable to
// start a transaction in the given time").

// Hard cap on how many shelf items may reach the fuzzy-fallback tier in a
// single sync run -- defense-in-depth, not a fix for a known bug. The
// exact-match tiers above are now O(1) per shelf item, closing the
// specific bug that caused the 2026-07-18 production incident (every
// isbn-less item doing a full fuzzy scan). But the fuzzy tier itself is
// still O(pool) per item that reaches it, with no upper bound on how many
// items can reach it in one run -- today's safety margin ("most shelf
// items are exact-title repeats, so fuzzy rarely runs") is an assumption,
// not an enforced limit. 50 sits comfortably below the actual incident's
// 80-isbn-less-items number while still covering realistic legitimate
// traffic (a normal sync sees at most a handful of genuinely new/renamed
// items, not dozens). See docs/superpowers/specs/2026-07-19-fuzzy-fallback-cost-ceiling-design.md.
const FUZZY_FALLBACK_CAP = 50;

async function reconcileTbrItems(shelfItems: GoodreadsBook[]): Promise<void> {
  const existing = await prisma.goodreadsTbrItem.findMany({
    select: { id: true, title: true, author: true, isbn: true, coverImagePath: true },
  });

  const existingByIsbn = new Map<string, ExistingTbrItem>();
  // Precomputed once, not recomputed by normalizeTitle() inside the match
  // loop below for every (shelf item x candidate) pair -- normalizeTitle
  // does NFKD normalization plus several regex passes, so redoing it per
  // comparison adds real, avoidable CPU work at the scale this function
  // already had one production incident over.
  const existingByNormalizedTitle = new Map<string, ExistingTbrItem[]>();
  for (const item of existing) {
    if (item.isbn) {
      existingByIsbn.set(item.isbn, item);
    }
    const normalized = normalizeTitle(item.title);
    const bucket = existingByNormalizedTitle.get(normalized);
    if (bucket) {
      bucket.push(item);
    } else {
      existingByNormalizedTitle.set(normalized, [item]);
    }
  }

  const matchedIds = new Set<string>();
  const toCreate: { title: string; author: string | null; isbn: string | null }[] = [];
  let fuzzyFallbackCount = 0;
  let hitFuzzyFallbackCap = false;

  for (const shelfItem of shelfItems) {
    let matched: ExistingTbrItem | null = null;
    const isbnCandidate = shelfItem.isbn ? existingByIsbn.get(shelfItem.isbn) : undefined;
    if (isbnCandidate && !matchedIds.has(isbnCandidate.id)) {
      matched = isbnCandidate;
    } else {
      const normalizedShelfTitle = normalizeTitle(shelfItem.title);
      const exactCandidates = existingByNormalizedTitle.get(normalizedShelfTitle);
      matched = exactCandidates?.find((item) => !matchedIds.has(item.id)) ?? null;

      if (!matched) {
        // Needs the fuzzy fallback -- capped as defense-in-depth (see
        // FUZZY_FALLBACK_CAP's doc comment below). Once the cap is hit,
        // this and every remaining fuzzy-needing shelf item this run is
        // deferred: not added to toCreate (would risk a duplicate row for
        // an item that actually has a match, destroying its preserved
        // cover -- the exact bug this whole reconciliation rework exists
        // to prevent), and its corresponding existing row (if any) is left
        // alone. It's simply an ordinary shelf item again next sync, when
        // the counter resets.
        if (fuzzyFallbackCount >= FUZZY_FALLBACK_CAP) {
          hitFuzzyFallbackCap = true;
          continue;
        }
        fuzzyFallbackCount++;
        const available = existing.filter((item) => !matchedIds.has(item.id));
        matched = findBestTitleMatch(available, shelfItem.title);
      }
    }

    if (matched) {
      matchedIds.add(matched.id);
      if (
        matched.title !== shelfItem.title ||
        matched.author !== shelfItem.author ||
        matched.isbn !== shelfItem.isbn
      ) {
        await prisma.goodreadsTbrItem.update({
          where: { id: matched.id },
          data: { title: shelfItem.title, author: shelfItem.author, isbn: shelfItem.isbn },
        });
      }
    } else {
      toCreate.push({ title: shelfItem.title, author: shelfItem.author, isbn: shelfItem.isbn });
    }
  }

  if (toCreate.length > 0) {
    await prisma.goodreadsTbrItem.createMany({ data: toCreate });
  }

  if (hitFuzzyFallbackCap) {
    // Can't safely tell "genuinely removed from the shelf" apart from
    // "the true match for a deferred item" without doing the fuzzy match
    // -- skip deletion entirely this run rather than risk destroying a
    // row (and its cover) that a deferred item would have matched. A
    // stale row lingering one extra cycle is an acceptable trade for
    // guaranteed no data loss -- the same trade-off already made
    // deliberately elsewhere in this function's history (see the two
    // correctness-bug fixes documented in the comment above this
    // function).
    console.warn(
      `Goodreads TBR sync hit the fuzzy-fallback cap (${FUZZY_FALLBACK_CAP}) with shelf item(s) deferred to the next sync — row deletion skipped this run.`,
    );
    return;
  }

  const toDelete = existing.filter((item) => !matchedIds.has(item.id));
  for (const item of toDelete) {
    if (item.coverImagePath) {
      await deleteCoverImage(item.coverImagePath);
    }
  }
  if (toDelete.length > 0) {
    await prisma.goodreadsTbrItem.deleteMany({
      where: { id: { in: toDelete.map((item) => item.id) } },
    });
  }
}

const TBR_COVER_FETCH_CAP = 25;

// Fetches an Open Library cover for any TBR item that has an ISBN and has
// never had a cover-fetch attempt (coverCheckedAt null), capped per run so
// the initial backlog (every existing item, on the first sync after this
// shipped) fills in gradually over several cron cycles instead of one long
// burst against Open Library. coverCheckedAt is always set after an
// attempt, whether or not a cover was found -- see reconcileTbrItems's
// sibling concern above for why a permanently-missing cover must never be
// retried.
async function fetchMissingTbrCovers(): Promise<void> {
  const pending = await prisma.goodreadsTbrItem.findMany({
    where: { coverImagePath: null, coverCheckedAt: null, isbn: { not: null } },
    select: { id: true, isbn: true },
    take: TBR_COVER_FETCH_CAP,
  });

  for (const item of pending) {
    const lookup = await lookupIsbn(item.isbn!);
    let coverImagePath: string | undefined;
    if (lookup.coverUrl) {
      const result = await saveCoverFromUrl(lookup.coverUrl);
      if (!("error" in result)) {
        coverImagePath = result.coverImagePath;
      }
    }
    await prisma.goodreadsTbrItem.update({
      where: { id: item.id },
      data: { coverCheckedAt: new Date(), ...(coverImagePath ? { coverImagePath } : {}) },
    });
  }
}

// See reconcileTbrItems above for how GoodreadsTbrItem rows are kept in
// sync with the "to-read" shelf. The currently-reading/read shelves are
// additionally matched against existing Book rows to set readStatus/rating
// -- see docs/superpowers/specs/2026-07-15-read-status-ratings-design.md.
export async function syncGoodreadsTbr(userId: string): Promise<{ synced: number }> {
  const shelfItems = Object.fromEntries(
    await Promise.all(
      STATUS_SYNC_SHELVES.map(
        async (shelf) => [shelf, await fetchAllGoodreadsBooks(userId, shelf)] as const,
      ),
    ),
  ) as Record<GoodreadsShelf, GoodreadsBook[]>;

  await reconcileTbrItems(shelfItems["to-read"]);

  const books: StatusSyncBook[] = await prisma.book.findMany({ select: STATUS_SYNC_BOOK_SELECT });
  for (const shelf of STATUS_SYNC_SHELVES) {
    await applyShelfToBooks(shelf, shelfItems[shelf], books);
  }

  const synced = STATUS_SYNC_SHELVES.reduce((sum, shelf) => sum + shelfItems[shelf].length, 0);

  await fetchMissingTbrCovers();

  return { synced };
}
