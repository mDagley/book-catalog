import { prisma } from "@/lib/prisma";
import { titleMatchScore, titleForms, normalizeTitle, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";

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

export interface FindDuplicateGroupsResult {
  groups: DuplicateGroup[];
  truncated: boolean;
}

// Hard cap on total titleMatchScore calls per run -- defense-in-depth
// against the O(n^2) all-pairs shape below. Measured directly against this
// function (not assumed from the unrelated 2026-07-18 incident's numbers,
// which turned out not to transfer): ~2,500 titleMatchScore calls/second on
// this hardware, so 1500 bounds the fuzzy tier's worst case to roughly
// 0.6s, leaving headroom under the 1-second target even in the degenerate
// case where tier 1 resolves nothing (see the performance regression test
// in duplicates.test.ts). Exposed as an optional param (see
// findDuplicateBookGroups) purely so tests can exercise the cap without
// needing thousands of fixture rows.
const FUZZY_DUPLICATE_CAP = 1500;

// Narrow exception to the "never group two physical-only books" rule below,
// for the specific signature produced by syncOwnedPhysicalBooks's
// create-race (see docs/superpowers/specs/2026-07-19-owned-physical-sync-duplicate-race-design.md):
// two rows sharing an exact title AND author, both created from the same
// Goodreads shelf item by two concurrent sync runs. Requires BOTH authors
// to be non-null and equal -- deliberately stricter than "both null counts
// as a match," since the general "two different physical books share a
// title with no author entered" case (e.g. "Echo") must stay excluded, and
// a sync-race duplicate always carries whatever non-null author Goodreads
// reported for that shelf item.
function authorsMatchNonNull(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  // Same empty-normalization guard as the title check in
  // findDuplicateBookGroups: normalizeTitle() strips every non-ASCII
  // character, so two different non-Latin-script author names can both
  // normalize to "" and otherwise pass this check as "equal."
  const normalizedA = normalizeTitle(a);
  return normalizedA !== "" && normalizedA === normalizeTitle(b);
}

// A different, non-null ISBN on each side is a real signal of a different
// edition/printing, not a sync race, so that case is excluded. Either side
// missing an ISBN (Goodreads regularly omits it) isn't a conflict.
function isbnCompatible(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

// One-time cleanup helper for the duplicate Book rows the ISBN-only-match
// bug (fixed alongside this file -- see createBookWithCopyData) could have
// already created in production: any book previously scanned as a physical
// copy of a title already owned as an ebook/audiobook ended up as a second,
// separate row instead of one merged row. This groups existing Book rows by
// the same fuzzy title match used everywhere else in this codebase, purely
// for a human to review and confirm before merging -- it never merges
// anything on its own.
//
// Matching runs in two tiers to stay fast at real catalog scale (a naive
// all-pairs fuzzy scan over ~700+ books, most digitally owned, measured
// 111 seconds in production and blocked the server for unrelated
// navigation -- see docs/superpowers/specs/2026-07-19-duplicates-page-performance-design.md):
//
// - Tier 1 (free): this tool exists specifically to catch a physical scan
//   whose title differs from its ebook/audiobook sibling only in
//   formatting (series suffix, colon subtitle, "the/a/an") -- exactly what
//   titleForms() already normalizes into a small set of variant strings.
//   Two books sharing an exact normalized form are guaranteed to score 100,
//   so they're unioned directly with zero titleMatchScore calls.
// - Tier 2 (capped fuzzy fallback): the existing O(n^2) pair iteration
//   stays (cheap on its own -- plain comparisons over a few hundred rows
//   are sub-millisecond), but a pair only reaches the expensive
//   titleMatchScore call if it's digitally-relevant AND not already
//   unioned by tier 1. This is capped at fuzzyCap total calls; once hit,
//   remaining pairs are skipped for this run and `truncated: true` is
//   returned, since this page is human-reviewed and a silently incomplete
//   result could read as "no more duplicates."
export async function findDuplicateBookGroups(
  fuzzyCap: number = FUZZY_DUPLICATE_CAP,
): Promise<FindDuplicateGroupsResult> {
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

  // Simple union-find: any two books whose titles match (exact-form or
  // fuzzy) end up in the same group, transitively (A~B and B~C group A, B,
  // and C together even if A and C alone wouldn't score above threshold).
  const parent = new Map<string, string>();
  for (const c of candidates) parent.set(c.id, c.id);

  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression: repoint every visited node directly at the root, so
    // later find() calls on the same chain are O(1) instead of O(chain
    // length). Without this, a large group of candidates that all
    // fuzzy-match each other (e.g. many near-identical titles) can degrade
    // union() into building an O(n) linked chain, making repeated find()
    // calls during the same tier-2 pass quadratic overall -- exactly the
    // shape of blowup this rewrite exists to avoid.
    let node = id;
    while (parent.get(node) !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  // Tier 1: bucket every candidate under each of its titleForms() variants.
  // When a variant already has occupants, union with every one of them
  // (subject to the same digital-ownership rule tier 2 applies below) --
  // an exact normalized-form match is guaranteed to score 100, so no
  // titleMatchScore call is needed. Checking every prior occupant (not
  // just one representative) keeps this correct when 3+ candidates share
  // a form with mixed digital ownership: a single "current occupant"
  // slot would only ever compare a new arrival against the most recent
  // occupant, missing a required union with an earlier one.
  const byForm = new Map<string, DuplicateCandidate[]>();
  for (const c of candidates) {
    for (const form of titleForms(c.title)) {
      const bucket = byForm.get(form);
      if (bucket) {
        for (const occupant of bucket) {
          const neitherDigital = !c.hasEbook && !c.hasAudiobook && !occupant.hasEbook && !occupant.hasAudiobook;
          if (neitherDigital) {
            // Physical-only pair: only union if it matches the narrow
            // owned-physical-sync create-race signature -- an exact FULL
            // title match (not merely sharing this form), plus matching
            // non-null author and no ISBN conflict. Sharing a form is not
            // enough on its own: titleForms()'s series-suffix-strip and
            // colon-split can make two DIFFERENT volumes in the same
            // series by the same author (e.g. "Mistborn: The Final
            // Empire, Book 1" vs "Mistborn: The Well of Ascension, Book
            // 2") share a stripped-down variant like "mistborn" despite
            // having different full titles -- this is the exact
            // cross-contamination class already documented and fixed once
            // in goodreadsSync.ts (a colon-split prefix causing a false
            // 100 score between different books). Requiring full-title
            // equality closes it; every other case (general physical-only
            // pairs) stays excluded exactly as before.
            const normalizedTitle = normalizeTitle(c.title);
            if (
              // normalizeTitle() strips every non-ASCII character, so two
              // completely different non-Latin-script titles can both
              // normalize to "" -- guard against that degenerate case
              // trivially satisfying the equality check below.
              normalizedTitle === "" ||
              normalizedTitle !== normalizeTitle(occupant.title) ||
              !authorsMatchNonNull(c.author, occupant.author) ||
              !isbnCompatible(c.isbn, occupant.isbn)
            ) {
              continue;
            }
          }
          union(c.id, occupant.id);
        }
        bucket.push(c);
      } else {
        byForm.set(form, [c]);
      }
    }
  }

  // Tier 2: capped fuzzy fallback for pairs tier 1 didn't already group.
  let fuzzyCalls = 0;
  let truncated = false;
  outer: for (let i = 0; i < candidates.length; i++) {
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
      // Already grouped by tier 1 (or a prior tier-2 match) -- no need to
      // spend a fuzzy comparison confirming what's already known.
      if (find(a.id) === find(b.id)) continue;
      if (fuzzyCalls >= fuzzyCap) {
        truncated = true;
        break outer;
      }
      fuzzyCalls++;
      if (titleMatchScore(a.title, b.title) >= DEFAULT_MATCH_THRESHOLD) {
        union(a.id, b.id);
      }
    }
  }

  if (truncated) {
    console.warn(
      `findDuplicateBookGroups hit the fuzzy-comparison cap (${fuzzyCap}) -- some duplicates may not have been detected this run.`,
    );
  }

  const groups = new Map<string, DuplicateCandidate[]>();
  for (const c of candidates) {
    const root = find(c.id);
    const group = groups.get(root);
    if (group) group.push(c);
    else groups.set(root, [c]);
  }

  return {
    groups: Array.from(groups.values())
      .filter((group) => group.length > 1)
      .map((books) => ({ books })),
    truncated,
  };
}

// Moves every PhysicalCopy/EbookCopy/AudiobookCopy from `mergeIds` onto
// `keepId`, recomputes hasEbook/hasAudiobook from the post-reassignment row
// counts, then deletes the merged rows. Never touches `keepId`'s own
// title/author/isbn -- same never-overwrite safeguard
// createBookWithCopyData's fuzzy-match fallback uses, so a human confirming
// the wrong pair doesn't also corrupt the surviving row's identity, only
// its ownership data (which is reversible by re-running a sync, unlike
// title/author/isbn).
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

  // Counted before the transaction (rather than inside it) since the array
  // form of $transaction can't read intermediate results of its own
  // operations -- this app is single-user, so nothing else concurrently
  // modifies these specific rows in the interim.
  const [keepEbookCount, keepAudiobookCount, mergeEbookCount, mergeAudiobookCount] =
    await Promise.all([
      prisma.ebookCopy.count({ where: { bookId: keepId } }),
      prisma.audiobookCopy.count({ where: { bookId: keepId } }),
      prisma.ebookCopy.count({ where: { bookId: { in: mergeIds } } }),
      prisma.audiobookCopy.count({ where: { bookId: { in: mergeIds } } }),
    ]);
  const hasEbook = keepEbookCount + mergeEbookCount > 0;
  const hasAudiobook = keepAudiobookCount + mergeAudiobookCount > 0;

  await prisma.$transaction([
    prisma.physicalCopy.updateMany({
      where: { bookId: { in: mergeIds } },
      data: { bookId: keepId },
    }),
    prisma.ebookCopy.updateMany({
      where: { bookId: { in: mergeIds } },
      data: { bookId: keepId },
    }),
    prisma.audiobookCopy.updateMany({
      where: { bookId: { in: mergeIds } },
      data: { bookId: keepId },
    }),
    prisma.book.update({
      where: { id: keepId },
      data: { hasEbook, hasAudiobook },
    }),
    prisma.book.deleteMany({ where: { id: { in: mergeIds } } }),
  ]);

  return { ok: true };
}
