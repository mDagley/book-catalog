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

describe("getLibraryStats physical shelf", () => {
  it("counts formats per copy, not per book, and returns all four buckets", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Format Book",
        copies: { create: [{ format: "PAPERBACK" }, { format: "PAPERBACK" }] },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.formats.map((b) => b.label)).toEqual([
      "Hardcover",
      "Paperback",
      "Mass market",
      "Other",
    ]);
    expect(stats.formats.find((b) => b.label === "Paperback")!.count).toBe(2);
    expect(stats.formats.find((b) => b.label === "Hardcover")!.count).toBe(0);
  });

  it("format buckets sum to the total physical copy count", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Format Sum Book",
        copies: { create: [{ format: "HARDCOVER" }, { format: "OTHER" }] },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.formats.reduce((n, b) => n + b.count, 0)).toBe(2);
  });

  it("buckets publish years by decade and reports copies with no year separately", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Decade Book",
        copies: {
          create: [
            { format: "PAPERBACK", publishYear: 1998 },
            { format: "PAPERBACK", publishYear: 1991 },
            { format: "PAPERBACK", publishYear: 2003 },
            { format: "PAPERBACK" },
          ],
        },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.decades).toEqual([
      { label: "1990s", count: 2 },
      { label: "2000s", count: 1 },
    ]);
    expect(stats.publishYearUnknown).toBe(1);
  });

  it("ranks publishers by copy count, most first", async () => {
    await prisma.book.create({
      data: {
        title: "Test Stats Publisher Book",
        copies: {
          create: [
            { format: "PAPERBACK", publisher: "Test Stats Tor" },
            { format: "PAPERBACK", publisher: "Test Stats Tor" },
            { format: "PAPERBACK", publisher: "Test Stats Gollancz" },
          ],
        },
      },
    });

    const stats = await getLibraryStats();

    expect(stats.topPublishers[0]).toEqual({ label: "Test Stats Tor", count: 2 });
    expect(stats.topPublishers[1]).toEqual({ label: "Test Stats Gollancz", count: 1 });
  });
});

describe("getLibraryStats authors and TBR", () => {
  it("ranks authors by book count and excludes books with no author", async () => {
    await prisma.book.create({ data: { title: "Test Stats Author A1", author: "Test Stats Sanderson" } });
    await prisma.book.create({ data: { title: "Test Stats Author A2", author: "Test Stats Sanderson" } });
    await prisma.book.create({ data: { title: "Test Stats Author B1", author: "Test Stats Le Guin" } });
    await prisma.book.create({ data: { title: "Test Stats Author None", author: null } });

    const stats = await getLibraryStats();

    expect(stats.topAuthors[0]).toEqual({ label: "Test Stats Sanderson", count: 2 });
    expect(stats.topAuthors[1]).toEqual({ label: "Test Stats Le Guin", count: 1 });
    expect(stats.topAuthors.some((a) => a.label === null || a.label === "")).toBe(false);
    expect(stats.topAuthors.reduce((n, a) => n + a.count, 0)).toBe(3);
  });

  it("splits TBR items into owned and remaining gap", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Stats Tbr Owned", owned: true },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Stats Tbr Wanted A", owned: false },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Stats Tbr Wanted B", owned: false },
    });

    const stats = await getLibraryStats();

    expect(stats.tbr.total).toBe(3);
    expect(stats.tbr.owned).toBe(1);
    expect(stats.tbr.gap).toBe(2);
    expect(stats.tbr.owned + stats.tbr.gap).toBe(stats.tbr.total);
  });
});
