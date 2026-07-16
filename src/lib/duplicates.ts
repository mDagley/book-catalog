import { prisma } from "@/lib/prisma";
import { titleMatchScore, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";

export interface DuplicateCandidate {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  copiesCount: number;
  hasEbook: boolean;
  hasAudiobook: boolean;
}

export interface DuplicateGroup {
  books: DuplicateCandidate[];
}

// One-time cleanup helper for the duplicate Book rows the ISBN-only-match
// bug (fixed alongside this file -- see createBookWithCopyData) could have
// already created in production: any book previously scanned as a physical
// copy of a title already owned as an ebook/audiobook ended up as a second,
// separate row instead of one merged row. This groups existing Book rows by
// the same fuzzy title match used everywhere else in this codebase, purely
// for a human to review and confirm before merging -- it never merges
// anything on its own.
export async function findDuplicateBookGroups(): Promise<DuplicateGroup[]> {
  const books = await prisma.book.findMany({
    select: {
      id: true,
      title: true,
      author: true,
      isbn: true,
      hasEbook: true,
      hasAudiobook: true,
      _count: { select: { copies: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const candidates: DuplicateCandidate[] = books.map((book) => ({
    id: book.id,
    title: book.title,
    author: book.author,
    isbn: book.isbn,
    copiesCount: book._count.copies,
    hasEbook: book.hasEbook,
    hasAudiobook: book.hasAudiobook,
  }));

  // Simple union-find: any two books whose titles fuzzy-match end up in the
  // same group, transitively (A~B and B~C group A, B, and C together even if
  // A and C alone wouldn't score above threshold).
  const parent = new Map<string, string>();
  for (const c of candidates) parent.set(c.id, c.id);

  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  }
  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      // Skip the (expensive) fuzzy score entirely when NEITHER side is
      // digitally owned -- this tool exists specifically for the
      // physical-scan-duplicates-an-ebook/audiobook-row bug, not for
      // deduplicating physical-only books against each other, so a
      // physical-vs-physical pair is never a candidate group regardless of
      // title similarity. This is the same restriction
      // createBookWithCopyData's fuzzy-match fallback applies to its own
      // candidate pool, for the same false-positive-risk reason.
      if (!a.hasEbook && !a.hasAudiobook && !b.hasEbook && !b.hasAudiobook) continue;
      if (titleMatchScore(a.title, b.title) >= DEFAULT_MATCH_THRESHOLD) {
        union(a.id, b.id);
      }
    }
  }

  const groups = new Map<string, DuplicateCandidate[]>();
  for (const c of candidates) {
    const root = find(c.id);
    const group = groups.get(root);
    if (group) group.push(c);
    else groups.set(root, [c]);
  }

  return Array.from(groups.values())
    .filter((group) => group.length > 1)
    .map((books) => ({ books }));
}

// Moves every PhysicalCopy from `mergeIds` onto `keepId`, unions their
// ebook/audiobook ownership signals onto `keepId`, then deletes the merged
// rows. Never touches `keepId`'s own title/author/isbn -- same
// never-overwrite safeguard createBookWithCopyData's fuzzy-match fallback
// uses, so a human confirming the wrong pair doesn't also corrupt the
// surviving row's identity, only its ownership data (which is reversible by
// re-running a sync, unlike title/author/isbn).
export async function mergeBooksData(
  keepId: string,
  rawMergeIds: string[],
): Promise<{ ok: true } | { error: string }> {
  // De-duplicated up front: Prisma's `id: { in: [...] }` already de-dupes
  // ids internally, so comparing its result's length against a
  // not-yet-deduplicated input list below would wrongly report "not found"
  // whenever the same id appeared twice in `rawMergeIds`.
  const mergeIds = Array.from(new Set(rawMergeIds));

  if (mergeIds.includes(keepId)) {
    return { error: "Cannot merge a book into itself" };
  }

  const keep = await prisma.book.findUnique({ where: { id: keepId } });
  if (!keep) {
    return { error: "Book to keep was not found" };
  }

  const toMerge = await prisma.book.findMany({ where: { id: { in: mergeIds } } });
  if (toMerge.length !== mergeIds.length) {
    return { error: "One or more books to merge were not found" };
  }

  const mergedEbookIds = new Set(keep.absEbookItemIds);
  const mergedAudiobookIds = new Set(keep.absAudiobookItemIds);
  for (const book of toMerge) {
    for (const id of book.absEbookItemIds) mergedEbookIds.add(id);
    for (const id of book.absAudiobookItemIds) mergedAudiobookIds.add(id);
  }

  await prisma.$transaction([
    prisma.physicalCopy.updateMany({
      where: { bookId: { in: mergeIds } },
      data: { bookId: keepId },
    }),
    prisma.book.update({
      where: { id: keepId },
      data: {
        absEbookItemIds: Array.from(mergedEbookIds),
        absAudiobookItemIds: Array.from(mergedAudiobookIds),
        // Derived from the merged arrays themselves, not OR'd from the
        // input rows' own flags -- matches the invariant absSync.ts's
        // stale-link removal already relies on (hasEbook/hasAudiobook
        // always reflects "is the corresponding array non-empty"), so this
        // stays correct even if an input row's stored flag was ever
        // inconsistent with its own arrays.
        hasEbook: mergedEbookIds.size > 0,
        hasAudiobook: mergedAudiobookIds.size > 0,
      },
    }),
    prisma.book.deleteMany({ where: { id: { in: mergeIds } } }),
  ]);

  return { ok: true };
}
