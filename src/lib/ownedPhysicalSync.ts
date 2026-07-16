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

// Attaches a placeholder physical copy (format: "OTHER", since Goodreads has
// no concept of hardcover/paperback/etc.) to an existing Book matched by
// ISBN or fuzzy title -- or creates a new Book + copy when nothing matches.
// Never overwrites the matched book's title/author/isbn (same safeguard
// every other fuzzy-match-then-attach path in this codebase uses), and
// never adds a second copy to a book that already has one -- see the design
// spec's Scope section for why (no way to tell a sync-created copy apart
// from a user-entered one, so this sync only ever adds, never removes).
async function applyShelfItem(
  item: GoodreadsBook,
  candidates: OwnedPhysicalCandidate[],
): Promise<void> {
  let match: OwnedPhysicalCandidate | null = null;

  if (item.isbn) {
    // `candidates` is fetched with `orderBy: createdAt asc`, so the first
    // array match is deterministically the oldest -- same rule
    // createBookWithCopyData's ISBN branch uses for the same reason
    // (Book.isbn has no unique constraint).
    match = candidates.find((c) => c.isbn === item.isbn) ?? null;
  }
  if (!match) {
    match = findBestTitleMatch(candidates, item.title);
  }

  if (match) {
    if (match.copiesCount > 0) return;
    // match.copiesCount is a snapshot from the initial candidate read, so it
    // can go stale if another sync run (cron vs. manual refresh) adds a copy
    // to the same book while this loop is in progress. Re-check right before
    // creating to avoid a duplicate placeholder copy.
    const currentCount = await prisma.physicalCopy.count({ where: { bookId: match.id } });
    if (currentCount > 0) {
      match.copiesCount = currentCount;
      return;
    }
    await prisma.physicalCopy.create({ data: { bookId: match.id, format: "OTHER" } });
    match.copiesCount += 1;
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
