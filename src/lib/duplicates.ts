import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  titleForms,
  normalizeTitle,
  charCounts,
  scoreUpperBound,
  sequenceMatcherRatio,
  DEFAULT_MATCH_THRESHOLD,
} from "@/lib/matching";
import { recheckOwnedTbrItems } from "@/lib/tbrGap";
import { resolveListingCover } from "@/lib/listingCover";

export interface DuplicateCandidate {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  copiesCount: number;
  hasEbook: boolean;
  hasAudiobook: boolean;
  coverImagePath: string | null;
}

export interface DuplicateGroup {
  books: DuplicateCandidate[];
}

export interface FindDuplicateGroupsResult {
  groups: DuplicateGroup[];
  truncated: boolean;
}

// Hard cap on total sequenceMatcherRatio calls per run -- defense-in-depth
// against the O(n^2) all-pairs shape below, kept even though
// scoreUpperBound() prefiltering (see the tier-2 loop) makes it very rare
// to reach. The original version of this cap counted every
// titleMatchScore call, i.e. every candidate PAIR that reached tier 2 --
// at realistic catalog scale (~700 digitally-relevant rows) that's on the
// order of 245,000 pairs, almost none of which are real duplicates, so the
// cap (1500) was hit almost immediately and this page was truncating on
// nearly every visit (see the duplicates page performance design doc's
// follow-up note).
//
// scoreUpperBound() is an O(title length) filter, PROVEN to never exceed
// the true score (see its own doc comment), so gating the expensive
// O(len_a * len_b) sequenceMatcherRatio call behind it is lossless -- no
// pair that could reach DEFAULT_MATCH_THRESHOLD is skipped, only pairs that
// provably cannot. Measured directly against several 700-row fixtures of
// varying "how similar do these titles look" density (see
// duplicates.test.ts's performance regression test and its sibling
// investigation): a realistic mixed-length catalog produces on the order
// of tens of real sequenceMatcherRatio calls; a deliberately pathological
// catalog (700 titles built from a 15-word pool, 5 words each -- far
// denser overlap than any real library) still only reaches ~3,200 calls,
// completing in ~100ms. This cap is set well above that pathological case,
// not tuned to a 1-second budget: unlike the original version, this
// function is no longer called on every /books/duplicates page view (see
// refreshDuplicateGroupsCache()) -- it now runs once at the end of each
// sync/create/merge, alongside operations that already take seconds
// (network round-trips to ABS/Goodreads), so there's no interactive-page
// latency to protect. Exposed as an optional param (see
// findDuplicateBookGroups) purely so tests can exercise the cap without
// needing thousands of fixture rows.
const FUZZY_DUPLICATE_CAP = 50_000;

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
// - Tier 2 (bound-filtered fuzzy fallback): the existing O(n^2) pair
//   iteration stays (cheap on its own -- plain comparisons over a few
//   hundred rows are sub-millisecond), restricted to pairs that are
//   digitally-relevant AND not already unioned by tier 1. Each such pair is
//   run through scoreUpperBound() (matching.ts) BEFORE the expensive
//   sequenceMatcherRatio call -- a proven, lossless upper bound that lets
//   most non-duplicate pairs be rejected in O(title length) instead of
//   O(len_a * len_b). A hard cap on actual sequenceMatcherRatio calls
//   remains as defense-in-depth; once hit, remaining pairs are skipped for
//   this run and `truncated: true` is returned, since a silently
//   incomplete result could read as "no more duplicates."
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
      copies: {
        where: { coverImagePath: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { coverImagePath: true },
      },
      ebookCopies: {
        where: { coverImagePath: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { coverImagePath: true },
      },
      audiobookCopies: {
        where: { coverImagePath: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { coverImagePath: true },
      },
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
    coverImagePath: resolveListingCover(book),
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

  // Per-candidate titleForms() + per-form character counts, computed lazily
  // (only for candidates that actually reach a tier-2 comparison) and cached
  // by id so a candidate compared against many others in the O(n^2) loop
  // below only pays the titleForms()/charCounts() cost once.
  interface FormEntry {
    form: string;
    counts: Map<string, number>;
  }
  const formEntriesById = new Map<string, FormEntry[]>();
  function formEntriesFor(c: DuplicateCandidate): FormEntry[] {
    let entries = formEntriesById.get(c.id);
    if (!entries) {
      entries = titleForms(c.title).map((form) => ({ form, counts: charCounts(form) }));
      formEntriesById.set(c.id, entries);
    }
    return entries;
  }

  // Tier 2: capped fuzzy fallback for pairs tier 1 didn't already group.
  //
  // The O(n^2) pair loop itself stays (cheap on its own), but unlike a
  // naive version that calls the expensive O(len_a * len_b)
  // sequenceMatcherRatio for every reachable pair, each form-pair is first
  // checked against scoreUpperBound() -- an O(len_a + len_b) filter that's
  // a proven upper bound on the real score (see its doc comment in
  // matching.ts), so skipping a pair whose bound is already below
  // DEFAULT_MATCH_THRESHOLD (or below the best score already found for
  // this candidate pair) never discards a genuine match. This is what
  // keeps fuzzyCalls -- and therefore real risk of hitting fuzzyCap -- low
  // even though the loop still visits every candidate pair.
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

      const entriesA = formEntriesFor(a);
      const entriesB = formEntriesFor(b);
      let best = 0;
      // Labeled so a match found partway through this candidate pair's own
      // form-pairs can stop comparing further forms immediately -- without
      // this, `best` reaching DEFAULT_MATCH_THRESHOLD from an early form
      // pair didn't stop later form pairs (still eligible since their
      // bound could exceed the current `best`) from making another
      // sequenceMatcherRatio call, and if THAT call was the one to hit
      // fuzzyCap, `break outer` skipped the union below entirely --
      // silently dropping a match this run had already found and confirmed
      // (Copilot review finding on PR #44).
      formPair: for (const fa of entriesA) {
        for (const fb of entriesB) {
          const bound = scoreUpperBound(fa.form, fa.counts, fb.form, fb.counts);
          if (bound < DEFAULT_MATCH_THRESHOLD || bound <= best) continue;
          if (fuzzyCalls >= fuzzyCap) {
            truncated = true;
            break outer;
          }
          fuzzyCalls++;
          const score = sequenceMatcherRatio(fa.form, fb.form) * 100;
          if (score > best) best = score;
          if (best >= DEFAULT_MATCH_THRESHOLD) break formPair;
        }
      }
      if (best >= DEFAULT_MATCH_THRESHOLD) {
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

export interface PersistedDuplicateGroup {
  id: string;
  computedAt: Date;
  books: DuplicateCandidate[];
}

export interface GetDuplicateGroupsResult {
  groups: PersistedDuplicateGroup[];
  truncated: boolean;
  // null when refreshDuplicateGroupsCache() has never run -- the caller
  // (the duplicates page) uses this to bootstrap the cache on its very
  // first-ever visit rather than showing an empty page.
  computedAt: Date | null;
}

// Recomputes findDuplicateBookGroups() and persists the result as
// DuplicateGroup rows, replacing whatever was there before. Called at the
// end of every flow that can change which books look like duplicates of
// each other (ABS sync, owned-physical sync, manual book creation, and
// merge) -- see call sites in absSync.ts's route, ownedPhysicalSync.ts's
// route, actions/books.ts, and actions/duplicates.ts. The duplicates page
// itself only reads via getDuplicateGroups(), it never calls this,
// matching this project's data freshness model (persist derived state at
// write time, don't recompute on read).
export async function refreshDuplicateGroupsCache(): Promise<FindDuplicateGroupsResult> {
  const result = await findDuplicateBookGroups();

  // Computed once here (not left to each row's own DB-side now() default)
  // and passed explicitly to every row below -- DuplicateGroup.computedAt
  // and DuplicateDetectionRun.computedAt must describe the same refresh
  // run, and pulling one from the DB's clock (now()) while the other used
  // the app's clock (`new Date()`, as an earlier version of this function
  // did) risked the two drifting apart under any app/DB clock skew, even
  // though both are produced by this same call.
  const computedAt = new Date();

  // DuplicateGroup rows are fully disposable derived data (nothing else
  // references them, and Book.duplicateGroupId is ON DELETE SET NULL --
  // see the migration), so the simplest correct update is delete-then-
  // recreate rather than diffing old groups against new ones.
  await prisma.$transaction([
    prisma.duplicateGroup.deleteMany({}),
    ...result.groups.map((group) =>
      prisma.duplicateGroup.create({
        data: {
          computedAt,
          books: { connect: group.books.map((book) => ({ id: book.id })) },
        },
      }),
    ),
    prisma.duplicateDetectionRun.upsert({
      where: { id: "singleton" },
      create: { computedAt, truncated: result.truncated },
      update: { computedAt, truncated: result.truncated },
    }),
  ]);

  return result;
}

// Reads the persisted result of the most recent refreshDuplicateGroupsCache()
// run -- what the duplicates page renders. No titleMatchScore/fuzzy work
// happens here, just relational reads.
//
// The two queries run inside a transaction (not Promise.all) so they see
// one consistent snapshot -- without this, a refreshDuplicateGroupsCache()
// commit landing between the two independent queries could pair old
// DuplicateGroup rows with the new run's computedAt/truncated (or vice
// versa), showing a `truncated` flag or timestamp that doesn't actually
// describe the groups rendered alongside it.
export async function getDuplicateGroups(): Promise<GetDuplicateGroupsResult> {
  // Read Committed (Postgres's default) only guarantees each individual
  // statement its own fresh snapshot, not a snapshot shared across both
  // statements in this transaction -- RepeatableRead is what actually
  // pins both reads to the same point in time.
  const [groups, run] = await prisma.$transaction(
    [
      prisma.duplicateGroup.findMany({
        include: {
          books: {
            select: {
              id: true,
              title: true,
              author: true,
              isbn: true,
              hasEbook: true,
              hasAudiobook: true,
              _count: { select: { copies: true } },
              copies: {
                where: { coverImagePath: { not: null } },
                orderBy: { createdAt: "asc" },
                take: 1,
                select: { coverImagePath: true },
              },
              ebookCopies: {
                where: { coverImagePath: { not: null } },
                orderBy: { createdAt: "asc" },
                take: 1,
                select: { coverImagePath: true },
              },
              audiobookCopies: {
                where: { coverImagePath: { not: null } },
                orderBy: { createdAt: "asc" },
                take: 1,
                select: { coverImagePath: true },
              },
            },
          },
        },
        // computedAt alone isn't a stable sort key: every DuplicateGroup
        // row created by the same refreshDuplicateGroupsCache() run shares
        // one transaction-start timestamp (Postgres's now()/
        // CURRENT_TIMESTAMP is fixed for the whole transaction), so without
        // a tie-breaker, groups from the same run could reorder between
        // reads with no underlying data change. `id` (cuid, generated in
        // creation order) breaks the tie deterministically.
        orderBy: [{ computedAt: "asc" }, { id: "asc" }],
      }),
      prisma.duplicateDetectionRun.findUnique({ where: { id: "singleton" } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  return {
    // Every write path that can remove a book from a group (merge, and any
    // other Book deletion -- see deleteCopyData in copies.ts and
    // removeStaleAbsLinks in absSync.ts) is expected to call
    // refreshDuplicateGroupsCache() afterward, which never persists a
    // group below 2 books (see the filter in findDuplicateBookGroups).
    // This re-filters at read time anyway as defense-in-depth (Copilot
    // review finding on PR #44): if a future write path were ever missed,
    // a stale 1-book "group" would otherwise render a merge action with no
    // other book to merge into.
    groups: groups
      .filter((group) => group.books.length > 1)
      .map((group) => ({
        id: group.id,
        computedAt: group.computedAt,
        books: group.books.map((book) => ({
          id: book.id,
          title: book.title,
          author: book.author,
          isbn: book.isbn,
          copiesCount: book._count.copies,
          hasEbook: book.hasEbook,
          hasAudiobook: book.hasAudiobook,
          coverImagePath: resolveListingCover(book),
        })),
      })),
    truncated: run?.truncated ?? false,
    computedAt: run?.computedAt ?? null,
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

  // The merged-away titles are now gone from the Book table -- one of them
  // may have been the only thing keeping a TBR item marked owned. Runs
  // AFTER the transaction commits (and outside it, since the array form of
  // $transaction can't call application code) so this reads the
  // post-delete state, not a stale snapshot that still sees the doomed
  // titles as owned.
  await recheckOwnedTbrItems();

  // The merged-away rows are gone, so their DuplicateGroup row would need
  // to shrink (or, once it drops below 2 books, disappear entirely) --
  // recomputing from scratch is simpler and just as cheap as writing
  // dedicated shrink-or-delete logic for that one group, so this reuses
  // the same "recompute after data changes" hook the sync routes and
  // book-creation actions use rather than partially updating in place.
  await refreshDuplicateGroupsCache();

  return { ok: true };
}
