import { prisma } from "@/lib/prisma";
import { createTitleIndex, normalizeTitle } from "@/lib/matching";
import { fetchAllGoodreadsBooks, type GoodreadsBook } from "@/lib/goodreadsSync";
import { markTbrItemsOwnedByTitles } from "@/lib/tbrGap";
import { parseSeriesFromTitle } from "@/lib/series";

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

// The candidate pool GROWS during a sync (applyShelfItem pushes newly
// created books onto it), so this keeps an incrementally-extended index
// rather than a frozen snapshot -- a book created earlier in the same run
// must still be matchable, or the run creates duplicate rows (the bug
// PR #27 fixed).
interface PoolMatcher {
  find(item: GoodreadsBook): OwnedPhysicalCandidate | null;
  add(candidate: OwnedPhysicalCandidate): void;
}

function createPoolMatcher(pool: OwnedPhysicalCandidate[]): PoolMatcher {
  // `pool` is fetched with `orderBy: createdAt asc`, so first-writer-wins on
  // both maps deterministically keeps the OLDEST -- the same rule
  // createBookWithCopyData's ISBN branch uses, since Book.isbn has no unique
  // constraint.
  const byIsbn = new Map<string, OwnedPhysicalCandidate>();
  const byNormalizedTitle = new Map<string, OwnedPhysicalCandidate>();
  const fuzzyPool: OwnedPhysicalCandidate[] = [];

  const add = (candidate: OwnedPhysicalCandidate) => {
    if (candidate.isbn && !byIsbn.has(candidate.isbn)) byIsbn.set(candidate.isbn, candidate);
    const normalized = normalizeTitle(candidate.title);
    if (!byNormalizedTitle.has(normalized)) byNormalizedTitle.set(normalized, candidate);
    fuzzyPool.push(candidate);
  };
  for (const candidate of pool) add(candidate);

  return {
    add,
    find(item: GoodreadsBook): OwnedPhysicalCandidate | null {
      if (item.isbn) {
        const isbnMatch = byIsbn.get(item.isbn);
        if (isbnMatch) return isbnMatch;
      }
      const exact = byNormalizedTitle.get(normalizeTitle(item.title));
      if (exact) return exact;
      // Rebuilt per fuzzy miss rather than kept incrementally, because the
      // pool only grows on a genuinely-new title -- rare in steady state,
      // and the index is cheap next to the scan it replaces.
      return createTitleIndex(fuzzyPool).findBest(item.title);
    },
  };
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
  matcher: PoolMatcher,
  createdTitles: string[],
): Promise<void> {
  const match = matcher.find(item);

  if (match) {
    await attachPlaceholderCopy(match);
    return;
  }

  // No match via `matcher` (built from a snapshot taken once at the start of
  // the whole sync run, though kept current within the run by matcher.add())
  // -- before concluding this is a genuinely new book,
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
    freshMatch = createTitleIndex(freshCandidates).findBest(item.title);
  }
  if (freshMatch) {
    matcher.add(freshMatch);
    await attachPlaceholderCopy(freshMatch);
    return;
  }

  const series = parseSeriesFromTitle(item.title);
  const created = await prisma.book.create({
    data: {
      title: item.title,
      author: item.author,
      isbn: item.isbn,
      // seriesManual stays at its false default: this is a derived value,
      // not a hand-edit.
      seriesName: series?.seriesName ?? null,
      seriesPosition: series?.seriesPosition ?? null,
      copies: { create: { format: "OTHER" } },
    },
    select: CANDIDATE_SELECT,
  });
  // A genuinely new title. Recorded rather than marked here so the caller can
  // do ONE TBR ownership pass for the whole shelf -- a large initial sync
  // creates many books, and a scan per book would put real fuzzy-match CPU
  // load inside a single request. The two attach-to-existing paths above
  // (ISBN match, fuzzy-title match) deliberately record nothing: they
  // introduce no new title, they just add a copy to a Book already there.
  createdTitles.push(item.title);
  matcher.add(toCandidate(created));
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
  // Built once for the whole run; matcher.add() keeps it current as
  // applyShelfItem creates new books.
  const matcher = createPoolMatcher(books.map(toCandidate));

  const createdTitles: string[] = [];
  for (const item of items) {
    await applyShelfItem(item, matcher, createdTitles);
  }

  // One pass for every title this shelf actually created. No-ops when the
  // shelf added nothing new, which is the steady-state case.
  await markTbrItemsOwnedByTitles(createdTitles);

  return { synced: items.length };
}
