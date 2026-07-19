import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { findDuplicateBookGroups, mergeBooksData } from "@/lib/duplicates";

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
    const data = Array.from({ length: 700 }, (_, i) => ({
      title: `Test Duplicates Perf Scale Unique Title Number ${i}`,
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
