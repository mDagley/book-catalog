import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

function makeRequest(params: Record<string, string>): Request {
  const url = new URL("http://localhost/api/autocomplete");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
}

afterEach(async () => {
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Autocomplete" } } });
  await prisma.goodreadsTbrItem.deleteMany({
    where: { title: { startsWith: "Test Autocomplete" } },
  });
});

describe("GET /api/autocomplete", () => {
  it("returns 400 when scope is missing", async () => {
    const response = await GET(makeRequest({ q: "Mistborn" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid scope", async () => {
    const response = await GET(makeRequest({ scope: "nonsense", q: "Mistborn" }));
    expect(response.status).toBe(400);
  });

  it("returns an empty array without querying the database when q is under 2 characters", async () => {
    await prisma.book.create({ data: { title: "Test Autocomplete Short Query" } });

    const response = await GET(makeRequest({ scope: "home", q: "T" }));
    const data = await response.json();

    // The fixture above WOULD match if the DB were queried (its title contains "T") --
    // asserting an empty result here is what proves the length check short-circuits
    // before any query runs, not just that this particular query returned nothing.
    expect(data).toEqual([]);
  });

  it("returns matching title/author pairs for the home scope", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Mistborn", author: "Brandon Sanderson" },
    });

    // Query "Autocomplete Mistborn" rather than plain "Mistborn" -- the
    // route's `contains` match runs against the whole table, not just this
    // test's own "Test Autocomplete"-prefixed rows, so a generic word could
    // collide with an unrelated row and break this exact-equality assertion.
    // "Autocomplete Mistborn" is a substring unique to this test's fixture.
    const response = await GET(makeRequest({ scope: "home", q: "Autocomplete Mistborn" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Mistborn", author: "Brandon Sanderson" }]);
  });

  it("matches on author as well as title", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Elantris", author: "Test Autocomplete Sanderson, Brandon" },
    });

    // The author field has no "Test Autocomplete" cleanup prefix convention
    // of its own (afterEach only filters by title), so the fixture author
    // above embeds the "Test Autocomplete" token itself, and the query below
    // matches on that unique substring rather than the generic "Sanderson" --
    // same collision-avoidance reasoning as the other tests in this file.
    const response = await GET(makeRequest({ scope: "home", q: "Autocomplete Sanderson" }));
    const data = await response.json();

    expect(data.map((s: { title: string }) => s.title)).toContain("Test Autocomplete Elantris");
  });

  it("returns matching title/author pairs for the books scope", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Warbreaker", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "books", q: "Autocomplete Warbreaker" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Warbreaker", author: "Brandon Sanderson" }]);
  });

  it("matches a Book with zero physical copies for the books scope (deliberate parity with /books' own listing)", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Ebook Only", hasEbook: true },
    });

    const response = await GET(makeRequest({ scope: "books", q: "Autocomplete Ebook Only" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Ebook Only", author: null }]);
  });

  it("returns matching title/author pairs for the tbr scope", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Autocomplete Way of Kings", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "tbr", q: "Autocomplete Way of Kings" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Way of Kings", author: "Brandon Sanderson" }]);
  });

  it("excludes tbr items that are already owned, matching /tbr's not-yet-owned gap", async () => {
    await prisma.book.create({ data: { title: "Test Autocomplete Owned Title" } });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Autocomplete Owned Title", author: "Some Author" },
    });

    const response = await GET(makeRequest({ scope: "tbr", q: "Test Autocomplete Owned" }));
    const data = await response.json();

    expect(data).toEqual([]);
  });

  it("does not leak Book rows into the tbr scope or GoodreadsTbrItem rows into the home/books scopes", async () => {
    // Titles are deliberately dissimilar (not just "...Book" vs "...Tbr")
    // beyond their shared query prefix -- getTbrGap fuzzy-matches titles
    // against owned Books (see the dedicated ownership-exclusion test below),
    // so two near-identical titles here would make this test conflate that
    // filtering with the cross-table leak this test actually targets.
    await prisma.book.create({ data: { title: "Test Autocomplete Cross Scope Physical Book" } });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Autocomplete Cross Scope Wishlist Entry" },
    });

    const tbrResponse = await GET(makeRequest({ scope: "tbr", q: "Test Autocomplete Cross Scope" }));
    const tbrData = await tbrResponse.json();
    expect(tbrData.map((s: { title: string }) => s.title)).toEqual([
      "Test Autocomplete Cross Scope Wishlist Entry",
    ]);

    const homeResponse = await GET(
      makeRequest({ scope: "home", q: "Test Autocomplete Cross Scope" }),
    );
    const homeData = await homeResponse.json();
    expect(homeData.map((s: { title: string }) => s.title)).toEqual([
      "Test Autocomplete Cross Scope Physical Book",
    ]);
  });

  it("caps results at 8 entries", async () => {
    for (let i = 0; i < 10; i++) {
      await prisma.book.create({ data: { title: `Test Autocomplete Cap ${i}` } });
    }

    const response = await GET(makeRequest({ scope: "home", q: "Test Autocomplete Cap" }));
    const data = await response.json();

    expect(data).toHaveLength(8);
  });

  // The tbr scope caps in route.ts itself (gap.slice(0, SUGGESTION_LIMIT)),
  // not via a Prisma `take`, since getTbrGap returns the full not-yet-owned
  // gap with no limit param -- a materially different code path from the
  // other two scopes' DB-level cap, so it needs its own coverage.
  it("caps results at 8 entries for the tbr scope", async () => {
    for (let i = 0; i < 10; i++) {
      await prisma.goodreadsTbrItem.create({ data: { title: `Test Autocomplete Cap ${i}` } });
    }

    const response = await GET(makeRequest({ scope: "tbr", q: "Test Autocomplete Cap" }));
    const data = await response.json();

    expect(data).toHaveLength(8);
  });
});
