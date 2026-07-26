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
