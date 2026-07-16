import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { findDuplicateBookGroups, mergeBooksData } from "@/lib/duplicates";

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Duplicates" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Duplicates" } } });
});

describe("findDuplicateBookGroups", () => {
  it("groups two books with closely-matching titles together", async () => {
    const a = await prisma.book.create({ data: { title: "Test Duplicates The Way of Kings" } });
    const b = await prisma.book.create({ data: { title: "Test Duplicates The Way of Kings" } });

    const groups = await findDuplicateBookGroups();

    const group = groups.find((g) => g.books.some((book) => book.id === a.id));
    expect(group).toBeDefined();
    expect(group?.books.map((book) => book.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("does not group two books with dissimilar titles", async () => {
    await prisma.book.create({ data: { title: "Test Duplicates Distinctly Different First Book" } });
    await prisma.book.create({ data: { title: "Test Duplicates Wholly Unrelated Second Volume" } });

    const groups = await findDuplicateBookGroups();

    const relevantGroups = groups.filter((g) =>
      g.books.some((book) => book.title.startsWith("Test Duplicates")),
    );
    expect(relevantGroups).toEqual([]);
  });

  it("does not include a book that has no fuzzy-matching sibling", async () => {
    await prisma.book.create({ data: { title: "Test Duplicates Solo Book" } });

    const groups = await findDuplicateBookGroups();

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
        absEbookItemIds: ["dup-test-ebook-item"],
      },
    });

    const groups = await findDuplicateBookGroups();
    const group = groups.find((g) => g.books.some((book) => book.id === withCopy.id));

    const physical = group?.books.find((book) => book.id === withCopy.id);
    const ebook = group?.books.find((book) => book.hasEbook);
    expect(physical?.copiesCount).toBe(1);
    expect(ebook?.hasEbook).toBe(true);
    expect(ebook?.copiesCount).toBe(0);
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

  it("unions ebook/audiobook flags and item ids from the merged book onto the kept book", async () => {
    const keep = await prisma.book.create({
      data: {
        title: "Test Duplicates Union Book",
        hasEbook: true,
        absEbookItemIds: ["dup-test-keep-ebook"],
      },
    });
    const merge = await prisma.book.create({
      data: {
        title: "Test Duplicates Union Book",
        hasAudiobook: true,
        absAudiobookItemIds: ["dup-test-merge-audiobook"],
      },
    });

    const result = await mergeBooksData(keep.id, [merge.id]);

    expect(result).toEqual({ ok: true });
    const kept = await prisma.book.findUniqueOrThrow({ where: { id: keep.id } });
    expect(kept.hasEbook).toBe(true);
    expect(kept.hasAudiobook).toBe(true);
    expect(kept.absEbookItemIds).toEqual(["dup-test-keep-ebook"]);
    expect(kept.absAudiobookItemIds).toEqual(["dup-test-merge-audiobook"]);
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
});
