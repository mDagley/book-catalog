import { describe, it, expect, vi, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { syncOwnedPhysicalBooks, DEFAULT_OWNED_PHYSICAL_SHELF } from "@/lib/ownedPhysicalSync";

const originalFetch = global.fetch;

afterEach(async () => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Owned Physical" } } },
  });
  await prisma.ebookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Owned Physical" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Owned Physical" } } });
});

// Builds a minimal shelf RSS page from a list of items -- mirrors the same
// helper goodreadsSync.test.ts uses for its own shelf-based tests.
function buildRssPage(items: Array<{ title: string; author?: string; isbn13?: string }>): string {
  const itemsXml = items
    .map(
      (i) => `
    <item>
      <title>${i.title}</title>
      <author_name>${i.author ?? ""}</author_name>
      <isbn13>${i.isbn13 ?? ""}</isbn13>
    </item>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>${itemsXml}</channel></rss>`;
}

const EMPTY_RSS_PAGE = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel></channel></rss>`;

// Mocks a single page of shelf content, then an empty page to end pagination
// -- matches how fetchAllGoodreadsBooks stops once a page comes back empty.
function mockShelfFetch(pageContent: string): void {
  global.fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, text: async () => pageContent } as Response)
    .mockResolvedValue({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);
}

describe("syncOwnedPhysicalBooks", () => {
  it("attaches a placeholder copy to an existing book matched by ISBN", async () => {
    const existing = await prisma.book.create({
      data: { title: "Test Owned Physical ISBN Match Book", isbn: "9781112223334" },
    });

    mockShelfFetch(
      buildRssPage([
        { title: "A Completely Different Title", isbn13: "9781112223334" },
      ]),
    );

    const result = await syncOwnedPhysicalBooks("1993628", "owned-physical");

    expect(result).toEqual({ synced: 1 });
    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1);
    expect(updated.copies[0].format).toBe("OTHER");
    expect(updated.title).toBe("Test Owned Physical ISBN Match Book"); // not overwritten
  });

  it("attaches a placeholder copy to an existing book matched by fuzzy title when no ISBN matches", async () => {
    const existing = await prisma.book.create({
      data: {
        title: "Test Owned Physical Fuzzy Match Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "owned-test-ebook" } },
      },
    });

    mockShelfFetch(buildRssPage([{ title: "Test Owned Physical Fuzzy Match Book" }]));

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1);
    expect(updated.hasEbook).toBe(true); // untouched
  });

  it("skips a match that already has a physical copy", async () => {
    const existing = await prisma.book.create({
      data: {
        title: "Test Owned Physical Already Covered Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });

    mockShelfFetch(buildRssPage([{ title: "Test Owned Physical Already Covered Book" }]));

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1);
    expect(updated.copies[0].format).toBe("HARDCOVER"); // still the original, no second copy added
  });

  it("creates a new book with a placeholder copy when no match exists", async () => {
    mockShelfFetch(
      buildRssPage([
        { title: "Test Owned Physical Brand New Book", author: "Some Author", isbn13: "9789998887776" },
      ]),
    );

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const created = await prisma.book.findFirstOrThrow({
      where: { title: "Test Owned Physical Brand New Book" },
      include: { copies: true },
    });
    expect(created.author).toBe("Some Author");
    expect(created.isbn).toBe("9789998887776");
    expect(created.copies).toHaveLength(1);
    expect(created.copies[0].format).toBe("OTHER");
  });

  it("matches multiple shelf items against the same newly-created book within one sync run", async () => {
    mockShelfFetch(
      buildRssPage([
        { title: "Test Owned Physical Repeat Book", isbn13: "9781231231231" },
        { title: "Test Owned Physical Repeat Book" }, // same title, no isbn -- should fuzzy-match the one just created, not create a second row
      ]),
    );

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const matches = await prisma.book.findMany({
      where: { title: "Test Owned Physical Repeat Book" },
      include: { copies: true },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].copies).toHaveLength(1);
  });

  it("does not remove an existing copy when the shelf item is no longer present on a later sync", async () => {
    const existing = await prisma.book.create({
      data: { title: "Test Owned Physical Persistent Book" },
    });

    mockShelfFetch(buildRssPage([{ title: "Test Owned Physical Persistent Book" }]));
    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    // Second sync: the shelf is now empty (book removed from shelf on Goodreads).
    mockShelfFetch(EMPTY_RSS_PAGE);
    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    const updated = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(updated.copies).toHaveLength(1); // still there
  });

  it("re-checks the database for a concurrently-added copy before creating a placeholder", async () => {
    const existing = await prisma.book.create({
      data: { title: "Test Owned Physical Race Book" },
    });

    mockShelfFetch(buildRssPage([{ title: "Test Owned Physical Race Book" }]));

    // Simulate another process (e.g. the cron sync overlapping a manual
    // refresh) adding a physical copy between the initial candidate read
    // (which reported 0 copies) and this sync's create step.
    const countSpy = vi.spyOn(prisma.physicalCopy, "count").mockResolvedValueOnce(1);
    const createSpy = vi.spyOn(prisma.physicalCopy, "create");

    await syncOwnedPhysicalBooks("1993628", "owned-physical");

    expect(createSpy).not.toHaveBeenCalled();
    countSpy.mockRestore();
    createSpy.mockRestore();

    await prisma.physicalCopy.deleteMany({ where: { bookId: existing.id } });
  });

  it("re-checks the database for a concurrently-created book before creating a duplicate", async () => {
    // Simulates the exact race confirmed in production (three duplicate
    // "A Conjuring of Light" rows): another process (e.g. the cron sync
    // overlapping a manual "Refresh now", which has no mutual-exclusion
    // against the cron) creates a matching Book AFTER this sync's initial
    // candidate snapshot was taken but BEFORE it decides whether to
    // create one itself. Forcing the initial `book.findMany()` to return
    // empty mirrors that timing -- the concurrently-created row is
    // already really in the database throughout.
    const concurrentlyCreated = await prisma.book.create({
      data: { title: "Test Owned Physical Concurrent Race Book", isbn: "9780001112223" },
    });

    mockShelfFetch(
      buildRssPage([
        { title: "Test Owned Physical Concurrent Race Book", isbn13: "9780001112223" },
      ]),
    );
    const findManySpy = vi.spyOn(prisma.book, "findMany").mockResolvedValueOnce([]);

    await syncOwnedPhysicalBooks("1993628", "owned-physical");
    findManySpy.mockRestore();

    const matches = await prisma.book.findMany({
      where: { title: "Test Owned Physical Concurrent Race Book" },
      include: { copies: true },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(concurrentlyCreated.id);
    expect(matches[0].copies).toHaveLength(1);
  });

  it("defaults to the owned-physical shelf when no shelf name is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => EMPTY_RSS_PAGE } as Response);
    global.fetch = fetchMock;

    await syncOwnedPhysicalBooks("1993628");

    expect(DEFAULT_OWNED_PHYSICAL_SHELF).toBe("owned-physical");
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get("shelf")).toBe("owned-physical");
  });
});
