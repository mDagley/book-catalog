import { XMLParser } from "fast-xml-parser";
import type { ReadStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeIsbn as normalizeIsbnShared } from "@/lib/books";
import { findBestTitleMatch } from "@/lib/matching";

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

// Full replace (not upsert-by-id) for GoodreadsTbrItem since Goodreads' RSS
// feed exposes no stable per-item id to key on, and a book removed from the
// to-read shelf should disappear from the TBR gap view too -- per the
// original design spec. The currently-reading/read shelves are additionally
// matched against existing Book rows to set readStatus/rating -- see
// docs/superpowers/specs/2026-07-15-read-status-ratings-design.md.
export async function syncGoodreadsTbr(userId: string): Promise<{ synced: number }> {
  const shelfItems = Object.fromEntries(
    await Promise.all(
      STATUS_SYNC_SHELVES.map(
        async (shelf) => [shelf, await fetchAllGoodreadsBooks(userId, shelf)] as const,
      ),
    ),
  ) as Record<GoodreadsShelf, GoodreadsBook[]>;

  await prisma.$transaction([
    prisma.goodreadsTbrItem.deleteMany(),
    prisma.goodreadsTbrItem.createMany({
      data: shelfItems["to-read"].map((book) => ({
        title: book.title,
        author: book.author,
        isbn: book.isbn,
      })),
    }),
  ]);

  const books: StatusSyncBook[] = await prisma.book.findMany({ select: STATUS_SYNC_BOOK_SELECT });
  for (const shelf of STATUS_SYNC_SHELVES) {
    await applyShelfToBooks(shelf, shelfItems[shelf], books);
  }

  const synced = STATUS_SYNC_SHELVES.reduce((sum, shelf) => sum + shelfItems[shelf].length, 0);
  return { synced };
}
