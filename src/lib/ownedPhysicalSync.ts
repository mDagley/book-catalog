import { prisma } from "@/lib/prisma";
import { findBestTitleMatch } from "@/lib/matching";
import { fetchAllGoodreadsBooks, type GoodreadsBook } from "@/lib/goodreadsSync";

export const DEFAULT_OWNED_PHYSICAL_SHELF = "owned-physical";

interface OwnedPhysicalCandidate {
  id: string;
  title: string;
  isbn: string | null;
  copiesCount: number;
}

const CANDIDATE_SELECT = {
  id: true,
  title: true,
  isbn: true,
  _count: { select: { copies: true } },
} as const;

function toCandidate(book: {
  id: string;
  title: string;
  isbn: string | null;
  _count: { copies: number };
}): OwnedPhysicalCandidate {
  return { id: book.id, title: book.title, isbn: book.isbn, copiesCount: book._count.copies };
}

// `candidates` is fetched with `orderBy: createdAt asc`, so the first array
// match is deterministically the oldest -- same rule createBookWithCopyData's
// ISBN branch uses for the same reason (Book.isbn has no unique constraint).
function matchAgainstPool(
  item: GoodreadsBook,
  pool: OwnedPhysicalCandidate[],
): OwnedPhysicalCandidate | null {
  if (item.isbn) {
    const isbnMatch = pool.find((c) => c.isbn === item.isbn);
    if (isbnMatch) return isbnMatch;
  }
  return findBestTitleMatch(pool, item.title);
}

// Adds a placeholder physical copy (format: "OTHER", since Goodreads has no
// concept of hardcover/paperback/etc.) to `match`, unless it already has
// one -- never adds a second copy to a book that already has one, see the
// design spec's Scope section for why (no way to tell a sync-created copy
// apart from a user-entered one, so this sync only ever adds, never
// removes).
async function attachPlaceholderCopy(match: OwnedPhysicalCandidate): Promise<void> {
  if (match.copiesCount > 0) return;
  // match.copiesCount can be a snapshot from an earlier read, so it can go
  // stale if another sync run (cron vs. manual refresh) adds a copy to the
  // same book while this loop is in progress. Re-check right before
  // creating to avoid a duplicate placeholder copy.
  const currentCount = await prisma.physicalCopy.count({ where: { bookId: match.id } });
  if (currentCount > 0) {
    match.copiesCount = currentCount;
    return;
  }
  await prisma.physicalCopy.create({ data: { bookId: match.id, format: "OTHER" } });
  match.copiesCount += 1;
}

// Matches an incoming shelf item against an existing Book by ISBN or fuzzy
// title -- or creates a new Book + copy when nothing matches. Never
// overwrites a matched book's title/author/isbn (same safeguard every other
// fuzzy-match-then-attach path in this codebase uses).
async function applyShelfItem(
  item: GoodreadsBook,
  candidates: OwnedPhysicalCandidate[],
): Promise<void> {
  const match = matchAgainstPool(item, candidates);

  if (match) {
    await attachPlaceholderCopy(match);
    return;
  }

  // No match in `candidates` (a snapshot taken once at the start of the
  // whole sync run) -- before concluding this is a genuinely new book,
  // re-check the database fresh. The 30-minute cron tick has `noOverlap`
  // protection against overlapping ITSELF, but nothing prevents it from
  // overlapping a manual "Refresh now" click (or two manual clicks);
  // without this recheck, two concurrent runs both see "no match" against
  // their own stale snapshot and both create a separate Book for the same
  // title -- confirmed in production (three duplicate rows for the same
  // book, from a race between a cron tick and a manual refresh).
  //
  // ISBN is checked first via a narrow, targeted query -- cheap regardless
  // of catalog size, and covers the common case (Goodreads usually
  // provides isbn13 for well-known books). Only falls through to a full
  // fresh candidate fetch (for the fuzzy-title path) when ISBN alone
  // doesn't resolve it, so a large initial sync (many genuinely new items)
  // doesn't pay an O(total_books) query for every single one of them.
  let freshMatch: OwnedPhysicalCandidate | null = null;
  if (item.isbn) {
    const isbnMatch = await prisma.book.findFirst({
      where: { isbn: item.isbn },
      orderBy: { createdAt: "asc" },
      select: CANDIDATE_SELECT,
    });
    if (isbnMatch) freshMatch = toCandidate(isbnMatch);
  }
  if (!freshMatch) {
    const freshCandidates = (
      await prisma.book.findMany({ select: CANDIDATE_SELECT, orderBy: { createdAt: "asc" } })
    ).map(toCandidate);
    freshMatch = findBestTitleMatch(freshCandidates, item.title);
  }
  if (freshMatch) {
    candidates.push(freshMatch);
    await attachPlaceholderCopy(freshMatch);
    return;
  }

  const created = await prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      isbn: item.isbn,
      copies: { create: { format: "OTHER" } },
    },
    select: CANDIDATE_SELECT,
  });
  candidates.push(toCandidate(created));
}

// Syncs the user's "owned-physical" (or custom-configured) Goodreads shelf
// onto the catalog -- see
// docs/superpowers/specs/2026-07-16-owned-physical-goodreads-sync-design.md.
// Runs independently of syncGoodreadsTbr; only ever adds Book/PhysicalCopy
// rows, never removes them.
export async function syncOwnedPhysicalBooks(
  userId: string,
  shelfName: string = DEFAULT_OWNED_PHYSICAL_SHELF,
): Promise<{ synced: number }> {
  const items = await fetchAllGoodreadsBooks(userId, shelfName);

  const books = await prisma.book.findMany({
    select: CANDIDATE_SELECT,
    orderBy: { createdAt: "asc" },
  });
  const candidates: OwnedPhysicalCandidate[] = books.map(toCandidate);

  for (const item of items) {
    await applyShelfItem(item, candidates);
  }

  return { synced: items.length };
}
