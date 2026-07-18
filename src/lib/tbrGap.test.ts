import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getTbrGap, groupByInitial, type TbrGapItem } from "@/lib/tbrGap";

afterEach(async () => {
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test TBR" } } },
  });
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test TBR" } } } });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test TBR" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
});

describe("getTbrGap", () => {
  it("excludes a TBR item that matches an owned physical book", async () => {
    await prisma.book.create({
      data: { title: "Test TBR Owned Book", copies: { create: { format: "PAPERBACK" } } },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Owned Book", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Owned Book")).toBe(false);
  });

  it("excludes a TBR item that matches an ebook/audiobook-only Book", async () => {
    await prisma.book.create({
      data: {
        title: "Test TBR Abs Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-tbr-abs-1" } },
      },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Abs Book", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Abs Book")).toBe(false);
  });

  it("includes a TBR item not owned in any form", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Not Owned", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Not Owned")).toBe(true);
  });

  it("sorts by author when present, falling back to title otherwise", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Zzz Title", author: "Aaa Author" },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Bbb Title", author: null },
    });

    const gap = await getTbrGap();
    const titles = gap
      .filter((item) => item.title.startsWith("Test TBR"))
      .map((item) => item.title);

    // "Aaa Author" sorts before "Bbb Title" (its own sort key, since it has no author)
    expect(titles.indexOf("Test TBR Zzz Title")).toBeLessThan(
      titles.indexOf("Test TBR Bbb Title"),
    );
  });

  it("falls back to title when author is an empty string", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Zzz Title", author: "Aaa Author" },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Bbb Title", author: "" },
    });

    const gap = await getTbrGap();
    const titles = gap
      .filter((item) => item.title.startsWith("Test TBR"))
      .map((item) => item.title);

    // "Aaa Author" sorts before "Bbb Title" (its own sort key, since its author is empty)
    expect(titles.indexOf("Test TBR Zzz Title")).toBeLessThan(
      titles.indexOf("Test TBR Bbb Title"),
    );
  });

  it("filters by a case-insensitive title match when a query is given", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mistborn", author: "Brandon Sanderson" },
    });

    const gap = await getTbrGap("mistborn");

    expect(gap.some((item) => item.title === "Test TBR Mistborn")).toBe(true);
  });

  it("filters by a case-insensitive author match when a query is given", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Elantris", author: "Brandon Sanderson" },
    });

    const gap = await getTbrGap("sanderson");

    expect(gap.some((item) => item.title === "Test TBR Elantris")).toBe(true);
  });

  it("excludes items that don't match the query", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Elantris", author: "Brandon Sanderson" },
    });

    const gap = await getTbrGap("Test TBR Nonexistent Zzzzz");

    expect(gap.some((item) => item.title === "Test TBR Elantris")).toBe(false);
  });

  it("returns everything when the query is empty or undefined", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Elantris", author: "Brandon Sanderson" },
    });

    const gapUndefined = await getTbrGap();
    const gapEmpty = await getTbrGap("   ");

    expect(gapUndefined.some((item) => item.title === "Test TBR Elantris")).toBe(true);
    expect(gapEmpty.some((item) => item.title === "Test TBR Elantris")).toBe(true);
  });
});

describe("groupByInitial", () => {
  function item(title: string, author: string | null): TbrGapItem {
    return { id: title, title, author };
  }

  it("groups items by the uppercased first character of their sort key", () => {
    const groups = groupByInitial([
      item("Elantris", "Brandon Sanderson"),
      item("A Wizard of Earthsea", "Ursula K. Le Guin"),
    ]);

    expect(groups).toEqual([
      { letter: "B", items: [item("Elantris", "Brandon Sanderson")] },
      { letter: "U", items: [item("A Wizard of Earthsea", "Ursula K. Le Guin")] },
    ]);
  });

  it("falls back to title when author is null", () => {
    const groups = groupByInitial([item("Zzz Title", null)]);

    expect(groups).toEqual([{ letter: "Z", items: [item("Zzz Title", null)] }]);
  });

  it("buckets a non-letter first character under '#'", () => {
    const groups = groupByInitial([item("1984", null)]);

    expect(groups).toEqual([{ letter: "#", items: [item("1984", null)] }]);
  });

  it("buckets an accented first letter under its unaccented equivalent, not '#'", () => {
    const groups = groupByInitial([item("Zola", "Émile Zola")]);

    expect(groups).toEqual([{ letter: "E", items: [item("Zola", "Émile Zola")] }]);
  });

  it("does not include a letter with zero matching items", () => {
    const groups = groupByInitial([item("Elantris", "Brandon Sanderson")]);

    expect(groups.some((g) => g.letter === "Z")).toBe(false);
    expect(groups).toHaveLength(1);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupByInitial([])).toEqual([]);
  });

  it("preserves each group's relative item order", () => {
    const groups = groupByInitial([
      item("Aaa First", "Sanderson, A"),
      item("Aaa Second", "Sanderson, B"),
    ]);

    expect(groups).toEqual([
      {
        letter: "S",
        items: [item("Aaa First", "Sanderson, A"), item("Aaa Second", "Sanderson, B")],
      },
    ]);
  });
});
