import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getLibraryStats } from "@/lib/stats";

afterEach(async () => {
  await prisma.physicalCopy.deleteMany({ where: { book: { title: { startsWith: "Test Stats" } } } });
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test Stats" } } } });
  await prisma.audiobookCopy.deleteMany({ where: { book: { title: { startsWith: "Test Stats" } } } });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Stats" } } });
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test Stats" } } });
});

describe("getLibraryStats totals", () => {
  it("counts books and copies separately when one book has several physical copies", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Multi Copy Book",
        copies: { create: [{ format: "PAPERBACK" }, { format: "HARDCOVER" }] },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.totals.books).toBe(1);
    expect(stats.totals.copies).toBe(2);
    expect(stats.totals.physicalBooks).toBe(1);
  });

  it("counts a book owned in several formats once per format and once as multi-format", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Multi Format Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-stats-ebook-1" } },
        copies: { create: { format: "PAPERBACK" } },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.totals.books).toBe(1);
    expect(stats.totals.physicalBooks).toBe(1);
    expect(stats.totals.ebookBooks).toBe(1);
    expect(stats.totals.audiobookBooks).toBe(0);
    expect(stats.totals.multiFormatBooks).toBe(1);
  });

  it("does not count a single-format book as multi-format", async () => {
    await prisma.book.create({
      data: { title: "Test Stats Single Format Book", copies: { create: { format: "PAPERBACK" } } },
    });

    const stats = await getLibraryStats();

    expect(stats.totals.multiFormatBooks).toBe(0);
  });

  it("returns zeroes for an empty library without throwing", async () => {
    const stats = await getLibraryStats();

    expect(stats.totals.books).toBe(0);
    expect(stats.totals.copies).toBe(0);
    expect(stats.totals.multiFormatBooks).toBe(0);
  });
});

describe("getLibraryStats reading", () => {
  it("reports a null readStatus as its own bucket, not as to-read", async () => {
    await prisma.book.create({ data: { title: "Test Stats No Status Book" } });
    await prisma.book.create({ data: { title: "Test Stats To Read Book", readStatus: "TO_READ" } });

    const stats = await getLibraryStats();
    const byLabel = Object.fromEntries(stats.readStatus.map((b) => [b.label, b.count]));

    expect(byLabel["No status"]).toBe(1);
    expect(byLabel["To read"]).toBe(1);
  });

  it("always returns all four read-status buckets, including empty ones", async () => {
    await prisma.book.create({ data: { title: "Test Stats Only Read Book", readStatus: "READ" } });

    const stats = await getLibraryStats();

    expect(stats.readStatus.map((b) => b.label)).toEqual([
      "Read",
      "Reading",
      "To read",
      "No status",
    ]);
    expect(stats.readStatus.find((b) => b.label === "Reading")!.count).toBe(0);
  });

  it("always returns all six rating buckets and counts unrated separately", async () => {
    await prisma.book.create({ data: { title: "Test Stats Rated Five", rating: 5 } });
    await prisma.book.create({ data: { title: "Test Stats Unrated Book" } });

    const stats = await getLibraryStats();

    expect(stats.ratings.map((b) => b.label)).toEqual([
      "5 stars",
      "4 stars",
      "3 stars",
      "2 stars",
      "1 star",
      "Unrated",
    ]);
    expect(stats.ratings.find((b) => b.label === "5 stars")!.count).toBe(1);
    expect(stats.ratings.find((b) => b.label === "Unrated")!.count).toBe(1);
    expect(stats.ratings.find((b) => b.label === "3 stars")!.count).toBe(0);
  });

  it("read-status buckets sum to the total book count", async () => {
    await prisma.book.create({ data: { title: "Test Stats Sum A", readStatus: "READ" } });
    await prisma.book.create({ data: { title: "Test Stats Sum B", readStatus: "READING" } });
    await prisma.book.create({ data: { title: "Test Stats Sum C" } });

    const stats = await getLibraryStats();

    expect(stats.readStatus.reduce((n, b) => n + b.count, 0)).toBe(stats.totals.books);
    expect(stats.ratings.reduce((n, b) => n + b.count, 0)).toBe(stats.totals.books);
  });
});
