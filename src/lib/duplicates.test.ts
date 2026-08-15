import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  findDuplicateBookGroups,
  mergeBooksData,
  refreshDuplicateGroupsCache,
  getDuplicateGroups,
} from "@/lib/duplicates";
import { titleForms } from "@/lib/matching";

afterEach(async () => {
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test Duplicates" } } } });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Duplicates" } } },
  });
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Duplicates" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Duplicates" } } });
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test Duplicates" } } });
  // Book.duplicateGroupId is ON DELETE SET NULL, so the deleteMany above
  // leaves the now-empty DuplicateGroup row behind -- clean those up too so
  // they don't accumulate across test runs.
  await prisma.duplicateGroup.deleteMany({ where: { books: { none: {} } } });
});

describe("findDuplicateBookGroups", () => {
  it("groups two books with closely-matching titles together when at least one is digitally owned", async () => {
    const a = await prisma.book.create({
      data: { title: "Test Duplicates The Way of Kings", copies: { create: { format: "HARDCOVER" } } },
    });
    const b = await prisma.book.create({
      data: {
        title: "Test Duplicates The Way of Kings",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-group-ebook" } },
      },
    });

    const { groups, truncated } = await findDuplicateBookGroups();

    expect(truncated).toBe(false);
    const group = groups.find((g) => g.books.some((book) => book.id === a.id));
    expect(group).toBeDefined();
    expect(group?.books.map((book) => book.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("groups books whose titles differ only in formatting the exact-form tier normalizes away", async () => {
    // "Way of Kings" vs "The Way of Kings: Stormlight Archive, Book 1" --
    // colon-split, series-suffix-stripped, and "the"-stripped all reduce to
    // the same titleForms() variant, so tier 1 should catch this without
    // ever needing a fuzzy titleMatchScore call.
    const a = await prisma.book.create({
      data: { title: "Test Duplicates Way of Kings", copies: { create: { format: "HARDCOVER" } } },
    });
    const b = await prisma.book.create({
      data: {
        title: "Test Duplicates The Way of Kings: Stormlight Archive, Book 1",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-exact-form-ebook" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();

    const group = groups.find((g) => g.books.some((book) => book.id === a.id));
    expect(group?.books.map((book) => book.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("does not group two purely physical books, even with identical titles", async () => {
    // The tool exists specifically for the physical-scan-duplicates-a-
    // digital-row bug -- two physical-only books sharing a title are more
    // likely to just be two genuinely different books (e.g. a common title
    // like "Echo" used by unrelated authors) than the same book split in
    // two, so they're intentionally never grouped.
    await prisma.book.create({
      data: { title: "Test Duplicates Purely Physical Duplicate", copies: { create: { format: "HARDCOVER" } } },
    });
    await prisma.book.create({
      data: { title: "Test Duplicates Purely Physical Duplicate", copies: { create: { format: "PAPERBACK" } } },
    });

    const { groups } = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.title === "Test Duplicates Purely Physical Duplicate"),
    );
    expect(relevantGroups).toEqual([]);
  });

  it("still does not group two purely physical books sharing a title but with different authors", async () => {
    // Reinforces the general case above with explicit, differing authors
    // (not just both-null) -- e.g. "Echo" by two unrelated real authors
    // must never be treated as the sync-race signature below.
    await prisma.book.create({
      data: {
        title: "Test Duplicates Different Authors Same Title",
        author: "Author One",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Duplicates Different Authors Same Title",
        author: "Author Two",
        copies: { create: { format: "PAPERBACK" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.title === "Test Duplicates Different Authors Same Title"),
    );
    expect(relevantGroups).toEqual([]);
  });

  it("does not group two DIFFERENT physical books in the same series/author sharing only a stripped titleForms() variant", async () => {
    // Copilot review finding on PR #27 (verified directly against
    // titleForms()/normalizeTitle before accepting): "Mistborn: The Final
    // Empire, Book 1" and "Mistborn: The Well of Ascension, Book 2" are
    // genuinely different books, but titleForms()'s series-suffix-strip
    // and colon-split both reduce them to a shared "mistborn" variant
    // (their FULL normalized titles differ). Sharing a form is not the
    // same as an exact-title match -- this is exactly the cross-
    // contamination class already documented and fixed once in
    // goodreadsSync.ts's own comments (colon-split prefix causing two
    // different books in a series to score a perfect match). The
    // physical-only exception must require full normalized-title
    // equality, not merely a shared form, or it reintroduces this.
    await prisma.book.create({
      data: {
        title: "Test Duplicates Mistborn: The Final Empire, Book 1",
        author: "Brandon Sanderson",
        copies: { create: { format: "OTHER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Duplicates Mistborn: The Well of Ascension, Book 2",
        author: "Brandon Sanderson",
        copies: { create: { format: "OTHER" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.title.startsWith("Test Duplicates Mistborn:")),
    );
    expect(relevantGroups).toEqual([]);
  });

  it("does not group two different physical books whose titles both normalize to an empty string", async () => {
    // Low-confidence Copilot finding on PR #27, verified directly before
    // accepting: normalizeTitle() strips every non-ASCII character, so
    // two completely different non-Latin-script titles (verified: two
    // real, different Japanese book titles) both normalize to "" --
    // sharing that degenerate titleForms() variant AND trivially passing
    // a naive normalizeTitle(a) === normalizeTitle(b) equality check
    // ("" === ""). These fixtures deliberately skip the "Test Duplicates"
    // prefix used elsewhere in this file -- an ASCII prefix would survive
    // normalization and defeat the point of this test -- so they're
    // cleaned up explicitly instead of via the shared afterEach above.
    const a = await prisma.book.create({
      data: { title: "銀河鉄道の夜", author: "Same Author", copies: { create: { format: "OTHER" } } },
    });
    const b = await prisma.book.create({
      data: { title: "三体", author: "Same Author", copies: { create: { format: "OTHER" } } },
    });

    try {
      const { groups } = await findDuplicateBookGroups();
      const relevantGroups = groups.filter((g) =>
        g.books.some((book) => book.id === a.id || book.id === b.id),
      );
      expect(relevantGroups).toEqual([]);
    } finally {
      await prisma.physicalCopy.deleteMany({ where: { bookId: { in: [a.id, b.id] } } });
      await prisma.book.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    }
  });

  it("does not group two different physical books whose AUTHORS both normalize to an empty string", async () => {
    // Same class of finding as the title case above, this time on the
    // author side (also low-confidence Copilot, also verified real
    // before accepting): two different real non-Latin-script author
    // names both normalize to "" via normalizeTitle(), which
    // authorsMatchNonNull() reuses. With a shared ASCII title (survives
    // normalization, matches) and no ISBN conflict, this alone was
    // enough to satisfy the exception even though the two books are by
    // genuinely different people.
    const a = await prisma.book.create({
      data: {
        title: "Test Duplicates Empty Author Normalize Book",
        author: "田中太郎",
        copies: { create: { format: "OTHER" } },
      },
    });
    const b = await prisma.book.create({
      data: {
        title: "Test Duplicates Empty Author Normalize Book",
        author: "王小明",
        copies: { create: { format: "OTHER" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.id === a.id || book.id === b.id),
    );
    expect(relevantGroups).toEqual([]);
  });

  it("groups two purely physical books that are the owned-physical sync's exact-duplicate signature", async () => {
    // The real production bug this was built for: syncOwnedPhysicalBooks's
    // create-race (see docs/superpowers/specs/2026-07-19-owned-physical-sync-duplicate-race-design.md)
    // produces two rows sharing an exact title AND author (both come from
    // the same Goodreads shelf item), neither digitally owned, neither
    // with an ISBN (Goodreads' feed regularly omits it). That specific
    // signature is safe to group even though general physical-only pairs
    // aren't.
    await prisma.book.create({
      data: {
        title: "Test Duplicates Sync Race Signature Book",
        author: "V.E. Schwab",
        copies: { create: { format: "OTHER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Duplicates Sync Race Signature Book",
        author: "V.E. Schwab",
        copies: { create: { format: "OTHER" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.title === "Test Duplicates Sync Race Signature Book"),
    );
    expect(relevantGroups).toHaveLength(1);
    expect(relevantGroups[0].books).toHaveLength(2);
  });

  it("does not group the sync-race signature when ISBNs conflict", async () => {
    // Same title and author, but two different non-null ISBNs -- a real
    // signal of a different edition/printing, not a sync race, so this
    // must stay excluded even though title+author match.
    await prisma.book.create({
      data: {
        title: "Test Duplicates Isbn Conflict Book",
        author: "Some Author",
        isbn: "9781111111111",
        copies: { create: { format: "OTHER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Duplicates Isbn Conflict Book",
        author: "Some Author",
        isbn: "9782222222222",
        copies: { create: { format: "OTHER" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.title === "Test Duplicates Isbn Conflict Book"),
    );
    expect(relevantGroups).toEqual([]);
  });

  it("does not group two books with dissimilar titles", async () => {
    await prisma.book.create({ data: { title: "Test Duplicates Distinctly Different First Book" } });
    await prisma.book.create({ data: { title: "Test Duplicates Wholly Unrelated Second Volume" } });

    const { groups } = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.title.startsWith("Test Duplicates")),
    );
    expect(relevantGroups).toEqual([]);
  });

  it("does not include a book that has no fuzzy-matching sibling", async () => {
    await prisma.book.create({ data: { title: "Test Duplicates Solo Book" } });

    const { groups } = await findDuplicateBookGroups();

    const found = groups.some((g) => g.books.some((book) => book.title === "Test Duplicates Solo Book"));
    expect(found).toBe(false);
  });

  it("reports copy count and ebook/audiobook flags per candidate", async () => {
    const withCopy = await prisma.book.create({
      data: {
        title: "Test Duplicates Reported Fields Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Duplicates Reported Fields Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-ebook-item" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();
    const group = groups.find((g) => g.books.some((book) => book.id === withCopy.id));

    const physical = group?.books.find((book) => book.id === withCopy.id);
    const ebook = group?.books.find((book) => book.hasEbook);
    expect(physical?.copiesCount).toBe(1);
    expect(ebook?.hasEbook).toBe(true);
    expect(ebook?.copiesCount).toBe(0);
  });

  it("reports each candidate's resolved cover image path", async () => {
    const withCover = await prisma.book.create({
      data: {
        title: "Test Duplicates Cover Field Book",
        copies: { create: { format: "HARDCOVER", coverImagePath: "physical-cover.jpg" } },
      },
    });
    const withoutCover = await prisma.book.create({
      data: {
        title: "Test Duplicates Cover Field Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-cover-item" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();
    const group = groups.find((g) => g.books.some((book) => book.id === withCover.id));

    const covered = group?.books.find((book) => book.id === withCover.id);
    const uncovered = group?.books.find((book) => book.id === withoutCover.id);
    expect(covered?.coverImagePath).toBe("physical-cover.jpg");
    expect(uncovered?.coverImagePath).toBeNull();
  });

  it("groups two books via genuine tier-2 fuzzy matching when they share no exact titleForms() variant", async () => {
    // "The Way of Kings" vs "The Way of King" -- a one-character typo, not
    // a formatting difference titleForms() normalizes away. Only real
    // fuzzy scoring (98.4, well above the 85 threshold) finds this. Without
    // this test, tier 2's actual match-and-union path (the titleMatchScore
    // call, the cap increment, its interaction with the already-grouped
    // skip) had no positive-case coverage at all -- every other passing
    // case was already resolved by tier 1.
    const titleA = "Test Duplicates The Way of Kings";
    const titleB = "Test Duplicates The Way of King";
    // Asserted, not just claimed in a comment (Copilot review finding on
    // PR #26): if a future titleForms() change ever made these share a
    // form, this test would silently stop proving what its name says --
    // it'd pass via tier 1 instead, with zero tier-2 coverage.
    const sharedForms = titleForms(titleA).filter((form) => titleForms(titleB).includes(form));
    expect(sharedForms).toEqual([]);

    const a = await prisma.book.create({
      data: { title: titleA, copies: { create: { format: "HARDCOVER" } } },
    });
    const b = await prisma.book.create({
      data: {
        title: titleB,
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-tier2-fuzzy-ebook" } },
      },
    });

    const { groups } = await findDuplicateBookGroups();

    const group = groups.find((g) => g.books.some((book) => book.id === a.id));
    expect(group?.books.map((book) => book.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("stops attempting further fuzzy comparisons once the cap is hit, and reports truncated", async () => {
    // Four digitally-owned books, each sharing enough letters with the
    // others (same word pool, shuffled) that scoreUpperBound() -- the
    // lossless O(title length) prefilter tier 2 now runs before the
    // expensive sequenceMatcherRatio -- cannot reject any of the 6 pairs
    // (every pairwise bound is >= DEFAULT_MATCH_THRESHOLD, verified
    // directly). Genuine sequenceMatcherRatio on every pair stays well
    // under DEFAULT_MATCH_THRESHOLD though (verified directly, max ~65),
    // so nothing gets unioned along the way -- which would otherwise let
    // the already-grouped skip short-circuit later pairs before the cap is
    // ever reached. That's 6 pairs, all requiring an actual
    // sequenceMatcherRatio call. A cap of 3 must be hit partway through.
    await prisma.book.createMany({
      data: [
        { title: "Test Duplicates Ember Haven Delta Lunar Pewter Birch", hasEbook: true },
        { title: "Test Duplicates Pewter Ember Karst Birch Lunar Haven", hasEbook: true },
        { title: "Test Duplicates Delta Pewter Lunar Cider Moraine Haven", hasEbook: true },
        { title: "Test Duplicates Nectar Haven Ember Birch Delta Amber", hasEbook: true },
      ],
    });

    const { truncated } = await findDuplicateBookGroups(3);

    expect(truncated).toBe(true);
  });

  it("does not report truncated when comparisons stay under the cap", async () => {
    await prisma.book.createMany({
      data: [
        { title: "Test Duplicates Undercap Alpha Volume", hasEbook: true },
        { title: "Test Duplicates Undercap Bravo Volume", hasEbook: true },
      ],
    });

    const { truncated } = await findDuplicateBookGroups(3);

    expect(truncated).toBe(false);
  });

  it("still unions a pair once its score already hit the threshold, even if a later form-pair for the SAME candidates would exceed the cap", async () => {
    // Copilot review finding on PR #44: these two titles share NO exact
    // titleForms() variant (verified directly -- so tier 1 doesn't catch
    // them for free, forcing an actual tier-2 comparison), but each has
    // multiple variants (the colon splits both). The FIRST form-pair
    // scoreUpperBound() lets through already scores ~97.3 (verified
    // directly, above DEFAULT_MATCH_THRESHOLD), but a later form-pair for
    // this same (a, b) candidate pair still has a bound above that ~97.3,
    // so it isn't skipped by `bound <= best` either -- so with the old code
    // (no early exit once `best` hits the threshold), a cap of exactly 1
    // would let the first call set best~97.3, then hit the cap on the
    // second call and `break outer` WITHOUT ever reaching the union below
    // it, silently dropping a match already confirmed within this very
    // pair.
    const a = await prisma.book.create({
      data: {
        title: "Test Duplicates Shadows: Rise of the Shadows",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-samepair-cap-ebook" } },
      },
    });
    const b = await prisma.book.create({
      data: {
        title: "Test Duplicates Rising: Rise of the Shadow",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    const { groups, truncated } = await findDuplicateBookGroups(1);

    expect(truncated).toBe(false);
    const group = groups.find((g) => g.books.some((book) => book.id === a.id));
    expect(group?.books.map((book) => book.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("completes quickly at a realistic catalog size (performance regression guard)", async () => {
    // An earlier version of this fixture generated titles as
    // `...Unique Title Number ${i}` -- identical ~48-char strings
    // differing only in a trailing number. That's NOT a realistic-scale
    // stress case: all 700 titles fuzzy-matched each other (a long shared
    // prefix plus a short numeric suffix scores well above threshold) and
    // collapsed into a single union-find group after only ~699
    // comparisons, nowhere near exercising the fuzzy cap. perfTitle()
    // below was verified (exhaustively, all 244,650 pairs, see
    // duplicates-page-performance-design.md's follow-up) to keep every
    // pairwise titleMatchScore comfortably under DEFAULT_MATCH_THRESHOLD
    // (max observed: ~70 vs. the 85 threshold), so this fixture actually
    // stresses the "many genuinely distinct books" path the two-tier
    // rewrite is meant to handle fast.
    function perfTitle(i: number): string {
      const tokens = [2654435761, 2246822519, 3266489917, 668265263].map((mult) =>
        (((i + 1) * mult) >>> 0).toString(36),
      );
      return `Test Duplicates ${tokens.join(" ")}`;
    }
    const data = Array.from({ length: 700 }, (_, i) => ({
      title: perfTitle(i),
      hasEbook: i % 2 === 0,
      hasAudiobook: i % 3 === 0,
    }));
    await prisma.book.createMany({ data });

    const start = Date.now();
    const { truncated } = await findDuplicateBookGroups();
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    // Regression guard for the real-world bug this fixture is modeling:
    // before the scoreUpperBound() prefilter, tier 2 counted every
    // digitally-relevant PAIR against the cap (not just pairs that reached
    // an actual sequenceMatcherRatio call), so at this scale (~700 rows,
    // ~245,000 candidate pairs) the cap was hit almost immediately and this
    // asserting `false` here would have failed -- silently masking that the
    // page was truncating on nearly every real visit.
    expect(truncated).toBe(false);
  });
});

describe("mergeBooksData", () => {
  it("moves physical copies from the merged book onto the kept book", async () => {
    const keep = await prisma.book.create({ data: { title: "Test Duplicates Keep Book" } });
    const merge = await prisma.book.create({
      data: {
        title: "Test Duplicates Keep Book",
        copies: { create: { format: "PAPERBACK", publisher: "Test Publisher" } },
      },
    });

    const result = await mergeBooksData(keep.id, [merge.id]);

    expect(result).toEqual({ ok: true });
    const kept = await prisma.book.findUniqueOrThrow({
      where: { id: keep.id },
      include: { copies: true },
    });
    expect(kept.copies).toHaveLength(1);
    expect(kept.copies[0].publisher).toBe("Test Publisher");
    const merged = await prisma.book.findUnique({ where: { id: merge.id } });
    expect(merged).toBeNull();
  });

  it("reassigns ebook/audiobook copies from the merged book onto the kept book, recomputing flags", async () => {
    const keep = await prisma.book.create({
      data: {
        title: "Test Duplicates Union Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-keep-ebook" } },
      },
    });
    const merge = await prisma.book.create({
      data: {
        title: "Test Duplicates Union Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "dup-test-merge-audiobook" } },
      },
    });

    const result = await mergeBooksData(keep.id, [merge.id]);

    expect(result).toEqual({ ok: true });
    const kept = await prisma.book.findUniqueOrThrow({
      where: { id: keep.id },
      include: { ebookCopies: true, audiobookCopies: true },
    });
    expect(kept.hasEbook).toBe(true);
    expect(kept.hasAudiobook).toBe(true);
    expect(kept.ebookCopies.map((c) => c.absItemId)).toEqual(["dup-test-keep-ebook"]);
    expect(kept.audiobookCopies.map((c) => c.absItemId)).toEqual(["dup-test-merge-audiobook"]);
  });

  it("does not overwrite the kept book's title/author/isbn", async () => {
    const keep = await prisma.book.create({
      data: { title: "Test Duplicates Original Title Book", author: "Original Author", isbn: "1112223334445" },
    });
    const merge = await prisma.book.create({
      data: { title: "Test Duplicates Original Title Book (Reissue)", author: "Different Author" },
    });

    await mergeBooksData(keep.id, [merge.id]);

    const kept = await prisma.book.findUniqueOrThrow({ where: { id: keep.id } });
    expect(kept.title).toBe("Test Duplicates Original Title Book");
    expect(kept.author).toBe("Original Author");
    expect(kept.isbn).toBe("1112223334445");
  });

  it("merges more than one book at once", async () => {
    const keep = await prisma.book.create({ data: { title: "Test Duplicates Triple Merge Book" } });
    const mergeA = await prisma.book.create({
      data: {
        title: "Test Duplicates Triple Merge Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    const mergeB = await prisma.book.create({
      data: {
        title: "Test Duplicates Triple Merge Book",
        copies: { create: { format: "PAPERBACK" } },
      },
    });

    const result = await mergeBooksData(keep.id, [mergeA.id, mergeB.id]);

    expect(result).toEqual({ ok: true });
    const kept = await prisma.book.findUniqueOrThrow({
      where: { id: keep.id },
      include: { copies: true },
    });
    expect(kept.copies).toHaveLength(2);
    expect(await prisma.book.findUnique({ where: { id: mergeA.id } })).toBeNull();
    expect(await prisma.book.findUnique({ where: { id: mergeB.id } })).toBeNull();
  });

  it("returns an error rather than merging a book into itself", async () => {
    const book = await prisma.book.create({ data: { title: "Test Duplicates Self Merge Book" } });

    const result = await mergeBooksData(book.id, [book.id]);

    expect(result).toEqual({ error: "Cannot merge a book into itself" });
    expect(await prisma.book.findUnique({ where: { id: book.id } })).not.toBeNull();
  });

  it("returns an error when a book to merge doesn't exist", async () => {
    const keep = await prisma.book.create({ data: { title: "Test Duplicates Missing Merge Book" } });

    const result = await mergeBooksData(keep.id, ["nonexistent-id"]);

    expect(result).toEqual({ error: "One or more books to merge were not found" });
  });

  it("marks the merged-away book's matching TBR item as no longer owned", async () => {
    // Verified with a temporary titleMatchScore scratch check (deleted after
    // use): these two titles score ~67, well under the 85 threshold, so the
    // keeper's own title can't also be what's keeping the TBR item owned --
    // only the loser's title can, and this test's assertion actually proves
    // the recheck ran off of that.
    const keep = await prisma.book.create({
      data: { title: "Test Duplicates Keeper Distinct Title Alpha" },
    });
    const merge = await prisma.book.create({
      data: {
        title: "Test Duplicates Loser Wholly Different Title Beta",
        copies: { create: { format: "PAPERBACK" } },
      },
    });
    const tbr = await prisma.goodreadsTbrItem.create({
      data: { title: "Test Duplicates Loser Wholly Different Title Beta", owned: true },
    });

    const result = await mergeBooksData(keep.id, [merge.id]);

    expect(result).toEqual({ ok: true });
    const after = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: tbr.id } });
    expect(after.owned).toBe(false);
  });

  it("does not falsely report a missing book when the same id is passed twice", async () => {
    const keep = await prisma.book.create({ data: { title: "Test Duplicates Repeated Id Book" } });
    const merge = await prisma.book.create({
      data: {
        title: "Test Duplicates Repeated Id Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    const result = await mergeBooksData(keep.id, [merge.id, merge.id]);

    expect(result).toEqual({ ok: true });
    const kept = await prisma.book.findUniqueOrThrow({
      where: { id: keep.id },
      include: { copies: true },
    });
    expect(kept.copies).toHaveLength(1);
  });
});

describe("refreshDuplicateGroupsCache / getDuplicateGroups", () => {
  it("persists findDuplicateBookGroups's result so getDuplicateGroups can read it back without recomputing", async () => {
    const a = await prisma.book.create({
      data: { title: "Test Duplicates Persisted Group Book", copies: { create: { format: "HARDCOVER" } } },
    });
    const b = await prisma.book.create({
      data: {
        title: "Test Duplicates Persisted Group Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-persist-ebook" } },
      },
    });

    const refreshed = await refreshDuplicateGroupsCache();
    expect(refreshed.truncated).toBe(false);

    const read = await getDuplicateGroups();
    expect(read.truncated).toBe(false);
    expect(read.computedAt).not.toBeNull();
    const group = read.groups.find((g) => g.books.some((book) => book.id === a.id));
    expect(group?.books.map((book) => book.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("clears a group once refreshed after its books no longer match (e.g. a title edit)", async () => {
    const a = await prisma.book.create({
      data: { title: "Test Duplicates Stale Group Book", copies: { create: { format: "HARDCOVER" } } },
    });
    const b = await prisma.book.create({
      data: {
        title: "Test Duplicates Stale Group Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-stale-ebook" } },
      },
    });
    await refreshDuplicateGroupsCache();
    let read = await getDuplicateGroups();
    expect(read.groups.some((g) => g.books.some((book) => book.id === a.id))).toBe(true);

    await prisma.book.update({
      where: { id: a.id },
      data: { title: "Test Duplicates Completely Different Title Entirely" },
    });
    await refreshDuplicateGroupsCache();

    read = await getDuplicateGroups();
    expect(read.groups.some((g) => g.books.some((book) => book.id === a.id))).toBe(false);
    expect(read.groups.some((g) => g.books.some((book) => book.id === b.id))).toBe(false);
  });

  it("removes a group's persisted row once mergeBooksData resolves it", async () => {
    const keep = await prisma.book.create({
      data: { title: "Test Duplicates Merge Refresh Book", copies: { create: { format: "HARDCOVER" } } },
    });
    const merge = await prisma.book.create({
      data: {
        title: "Test Duplicates Merge Refresh Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-merge-refresh-ebook" } },
      },
    });
    await refreshDuplicateGroupsCache();
    let read = await getDuplicateGroups();
    expect(read.groups.some((g) => g.books.some((book) => book.id === keep.id))).toBe(true);

    const result = await mergeBooksData(keep.id, [merge.id]);
    expect(result).toEqual({ ok: true });

    read = await getDuplicateGroups();
    expect(read.groups.some((g) => g.books.some((book) => book.id === keep.id))).toBe(false);
  });

  it("getDuplicateGroups reports computedAt: null before any refresh has ever run", async () => {
    await prisma.duplicateGroup.deleteMany({});
    await prisma.duplicateDetectionRun.deleteMany({});

    const read = await getDuplicateGroups();

    expect(read.computedAt).toBeNull();
    expect(read.groups).toEqual([]);
    expect(read.truncated).toBe(false);
  });

  it("getDuplicateGroups also reports each candidate's cover image path", async () => {
    const withCover = await prisma.book.create({
      data: {
        title: "Test Duplicates Cached Cover Book",
        copies: { create: { format: "HARDCOVER", coverImagePath: "cached-cover.jpg" } },
      },
    });
    await prisma.book.create({
      data: {
        title: "Test Duplicates Cached Cover Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "dup-test-cached-cover-item" } },
      },
    });

    await refreshDuplicateGroupsCache();
    const { groups } = await getDuplicateGroups();
    const group = groups.find((g) => g.books.some((book) => book.id === withCover.id));
    const covered = group?.books.find((book) => book.id === withCover.id);
    expect(covered?.coverImagePath).toBe("cached-cover.jpg");
  });
});
