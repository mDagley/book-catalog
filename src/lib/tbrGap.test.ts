import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  getTbrGap,
  groupByInitial,
  markTbrItemsOwnedByTitle,
  markTbrItemsOwnedByTitles,
  recheckOwnedTbrItems,
  recomputeAllTbrOwnership,
  type TbrGapItem,
} from "@/lib/tbrGap";

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
  it("excludes a TBR item marked owned", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Owned Flag Set", author: "Someone", owned: true },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Owned Flag Set")).toBe(false);
  });

  it("reflects real ownership end-to-end: creating a matching Book, then marking, excludes the item", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Owned End To End", author: "Someone" },
    });
    expect(
      (await getTbrGap()).some((item) => item.title === "Test TBR Owned End To End"),
    ).toBe(true);

    await prisma.book.create({ data: { title: "Test TBR Owned End To End" } });
    await markTbrItemsOwnedByTitle("Test TBR Owned End To End");

    expect(
      (await getTbrGap()).some((item) => item.title === "Test TBR Owned End To End"),
    ).toBe(false);
  });

  it("reflects a change immediately with no caching delay", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR No Cache Delay", author: "Someone" },
    });
    expect((await getTbrGap()).some((i) => i.title === "Test TBR No Cache Delay")).toBe(true);

    await prisma.goodreadsTbrItem.update({ where: { id: item.id }, data: { owned: true } });

    expect((await getTbrGap()).some((i) => i.title === "Test TBR No Cache Delay")).toBe(false);
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

  it("matches by ISBN when the query is ISBN-shaped, even if title/author don't contain it", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Isbn Match Book", author: "Someone", isbn: "9780765326355" },
    });

    const gap = await getTbrGap("9780765326355");

    expect(gap.some((item) => item.title === "Test TBR Isbn Match Book")).toBe(true);
  });

  it("matches by ISBN through hyphens in the query, via normalization", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Isbn Hyphen Book", author: "Someone", isbn: "9780765326355" },
    });

    const gap = await getTbrGap("978-0-7653-2635-5");

    expect(gap.some((item) => item.title === "Test TBR Isbn Hyphen Book")).toBe(true);
  });

  it("does not match an ISBN-shaped query against an unrelated item's isbn", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Isbn No Match Book", author: "Someone", isbn: "9780000000001" },
    });

    const gap = await getTbrGap("9780000000099");

    expect(gap.some((item) => item.title === "Test TBR Isbn No Match Book")).toBe(false);
  });
});

describe("groupByInitial", () => {
  function item(title: string, author: string | null): TbrGapItem {
    return { id: title, title, author, coverImagePath: null, isbn: null };
  }

  it("groups items by the uppercased first character of their sort key", () => {
    const groups = groupByInitial([
      item("Elantris", "Brandon Sanderson"),
      item("A Wizard of Earthsea", "Ursula K. Le Guin"),
    ]);

    expect(groups).toEqual([
      { letter: "L", items: [item("A Wizard of Earthsea", "Ursula K. Le Guin")] },
      { letter: "S", items: [item("Elantris", "Brandon Sanderson")] },
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
    const groups = groupByInitial([item("Test Book", "Jane Öztürk")]);

    expect(groups).toEqual([{ letter: "O", items: [item("Test Book", "Jane Öztürk")] }]);
  });

  it("groups by author last name, not first name", () => {
    const groups = groupByInitial([item("Elantris", "Brandon Sanderson")]);

    expect(groups).toEqual([{ letter: "S", items: [item("Elantris", "Brandon Sanderson")] }]);
  });

  it("keeps a name particle attached to the last name it precedes", () => {
    const groups = groupByInitial([item("A Wizard of Earthsea", "Ursula K. Le Guin")]);

    expect(groups).toEqual([{ letter: "L", items: [item("A Wizard of Earthsea", "Ursula K. Le Guin")] }]);
  });

  it("buckets a suffixed name by last name, not the suffix", () => {
    const groups = groupByInitial([item("Some Book", "John Smith Jr.")]);

    expect(groups).toEqual([{ letter: "S", items: [item("Some Book", "John Smith Jr.")] }]);
  });

  it("treats a 'Last, First' author as already last-name-first", () => {
    const groups = groupByInitial([item("Some Book", "Sanderson, Brandon")]);

    expect(groups).toEqual([{ letter: "S", items: [item("Some Book", "Sanderson, Brandon")] }]);
  });

  it("doesn't mistake a comma before a suffix for 'Last, First' format", () => {
    const groups = groupByInitial([item("Some Book", "John Smith, Jr.")]);

    expect(groups).toEqual([{ letter: "S", items: [item("Some Book", "John Smith, Jr.")] }]);
  });

  it("recognizes a suffix with an internal period, like 'Ph.D.'", () => {
    const groups = groupByInitial([item("Some Book", "Jane Doe Ph.D.")]);

    expect(groups).toEqual([{ letter: "D", items: [item("Some Book", "Jane Doe Ph.D.")] }]);
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

describe("markTbrItemsOwnedByTitle", () => {
  it("flips a currently-unowned matching item to owned", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mark Elantris", author: "Brandon Sanderson" },
    });

    await markTbrItemsOwnedByTitle("Test TBR Mark Elantris");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(true);
  });

  it("leaves a non-matching item unowned", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mark Unrelated", author: "Someone" },
    });

    await markTbrItemsOwnedByTitle("Test TBR Mark Completely Different Book");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(false);
  });

  it("does not touch an already-owned item", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Mark Already Owned", author: "Someone", owned: true },
    });

    await markTbrItemsOwnedByTitle("Test TBR Mark Already Owned");

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(true);
  });
});

describe("recheckOwnedTbrItems", () => {
  it("flips an owned item to unowned when no current Book matches it", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recheck Orphaned", author: "Someone", owned: true },
    });

    await recheckOwnedTbrItems();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(false);
  });

  it("leaves an owned item alone when a current Book still matches it", async () => {
    await prisma.book.create({ data: { title: "Test TBR Recheck Still Owned" } });
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recheck Still Owned", author: "Someone", owned: true },
    });

    await recheckOwnedTbrItems();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(true);
  });

  it("never touches an already-unowned item", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recheck Untouched", author: "Someone", owned: false },
    });

    await recheckOwnedTbrItems();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(false);
  });
});

describe("recomputeAllTbrOwnership", () => {
  it("flips an unowned item to owned when a Book matches it", async () => {
    await prisma.book.create({ data: { title: "Test TBR Recompute Newly Acquired" } });
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recompute Newly Acquired", author: "Someone", owned: false },
    });

    await recomputeAllTbrOwnership();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(true);
  });

  // The capability the one-way backfill script never had: correcting a
  // wrongly-owned row back to unowned.
  it("flips a wrongly-owned item back to unowned when no Book matches it", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recompute Stale Owned Flag", author: "Someone", owned: true },
    });

    await recomputeAllTbrOwnership();

    const updated = await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.owned).toBe(false);
  });

  it("leaves already-correct rows in both states alone", async () => {
    await prisma.book.create({ data: { title: "Test TBR Recompute Correct Owned" } });
    const owned = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recompute Correct Owned", author: "Someone", owned: true },
    });
    // Deliberately NOT "...Correct Unowned" -- that scores 97 against the
    // owned fixture above (one word differing out of five clears the 85
    // threshold easily), so it would legitimately be marked owned and this
    // test would fail for a reason that has nothing to do with the code.
    const unowned = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recompute Solitary Vellum Marginalia", author: "Someone", owned: false },
    });

    await recomputeAllTbrOwnership();

    expect(
      (await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: owned.id } })).owned,
    ).toBe(true);
    expect(
      (await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: unowned.id } })).owned,
    ).toBe(false);
  });

  it("reports how many rows it changed, and in which direction", async () => {
    await prisma.book.create({ data: { title: "Test TBR Recompute Counted Acquisition" } });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recompute Counted Acquisition", author: "Someone", owned: false },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Recompute Counted Divestment", author: "Someone", owned: true },
    });

    const result = await recomputeAllTbrOwnership();

    expect(result.markedOwned).toBe(1);
    expect(result.markedUnowned).toBe(1);
    expect(result.total).toBeGreaterThanOrEqual(2);
  });
});

describe("markTbrItemsOwnedByTitles", () => {
  it("marks items matching any title in the batch", async () => {
    const a = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Batch Zelphinar Quixotry", author: "A", owned: false },
    });
    const b = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Batch Brambleworth Mycelium", author: "B", owned: false },
    });
    const untouched = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Batch Solitary Vellum Threnody", author: "C", owned: false },
    });

    await markTbrItemsOwnedByTitles([
      "Test TBR Batch Zelphinar Quixotry",
      "Test TBR Batch Brambleworth Mycelium",
    ]);

    expect((await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: a.id } })).owned).toBe(true);
    expect((await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: b.id } })).owned).toBe(true);
    expect(
      (await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: untouched.id } })).owned,
    ).toBe(false);
  });

  it("does nothing, and issues no query, for an empty batch", async () => {
    const item = await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Batch Empty Case", author: "A", owned: false },
    });

    await markTbrItemsOwnedByTitles([]);

    expect((await prisma.goodreadsTbrItem.findUniqueOrThrow({ where: { id: item.id } })).owned).toBe(
      false,
    );
  });

  // The point of the batch form: a sync creating many books must not scan the
  // unowned TBR table once per created book.
  it("scans the unowned TBR items exactly once regardless of batch size", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Batch Scan Count Probe", author: "A", owned: false },
    });

    let findManyCalls = 0;
    const originalFindMany = prisma.goodreadsTbrItem.findMany;
    // @ts-expect-error -- narrow test-only spy on a real client method
    prisma.goodreadsTbrItem.findMany = (...args: unknown[]) => {
      findManyCalls++;
      // @ts-expect-error -- forwarding through to the real implementation
      return originalFindMany.apply(prisma.goodreadsTbrItem, args);
    };
    try {
      await markTbrItemsOwnedByTitles(
        Array.from({ length: 50 }, (_, i) => `Test TBR Batch Nonmatching Title ${i}`),
      );
    } finally {
      prisma.goodreadsTbrItem.findMany = originalFindMany;
    }

    expect(findManyCalls).toBe(1);
  });
});
