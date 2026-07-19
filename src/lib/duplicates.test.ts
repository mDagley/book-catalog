import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { findDuplicateBookGroups, mergeBooksData } from "@/lib/duplicates";
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
    // Four digitally-owned books with genuinely dissimilar titles (no
    // shared titleForms() variant, AND all pairwise titleMatchScore well
    // under DEFAULT_MATCH_THRESHOLD -- verified directly -- so none of
    // them get unioned along the way, which would otherwise let the
    // already-grouped skip short-circuit later pairs before the cap is
    // ever reached). That's 6 pairs, all requiring an actual
    // titleMatchScore call. A cap of 3 must be hit partway through.
    await prisma.book.createMany({
      data: [
        { title: "Test Duplicates Quantum Circuitry Repair Handbook", hasEbook: true },
        { title: "Test Duplicates Bicycle Maintenance Companion Guide", hasEbook: true },
        { title: "Test Duplicates Silent Orchard Evening Memories", hasEbook: true },
        { title: "Test Duplicates Granite Bridge Construction Journal", hasEbook: true },
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
    await findDuplicateBookGroups();
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
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
