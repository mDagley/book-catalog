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

    expect(data).toEqual([]);
  });

  it("returns matching title/author pairs for the home scope", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Mistborn", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "home", q: "Mistborn" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Mistborn", author: "Brandon Sanderson" }]);
  });

  it("matches on author as well as title", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Elantris", author: "Sanderson, Brandon" },
    });

    const response = await GET(makeRequest({ scope: "home", q: "Sanderson" }));
    const data = await response.json();

    expect(data.map((s: { title: string }) => s.title)).toContain("Test Autocomplete Elantris");
  });

  it("returns matching title/author pairs for the books scope", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Warbreaker", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "books", q: "Warbreaker" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Warbreaker", author: "Brandon Sanderson" }]);
  });

  it("matches a Book with zero physical copies for the books scope (deliberate parity with /books' own listing)", async () => {
    await prisma.book.create({
      data: { title: "Test Autocomplete Ebook Only", hasEbook: true },
    });

    const response = await GET(makeRequest({ scope: "books", q: "Ebook Only" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Ebook Only", author: null }]);
  });

  it("returns matching title/author pairs for the tbr scope", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test Autocomplete Way of Kings", author: "Brandon Sanderson" },
    });

    const response = await GET(makeRequest({ scope: "tbr", q: "Way of Kings" }));
    const data = await response.json();

    expect(data).toEqual([{ title: "Test Autocomplete Way of Kings", author: "Brandon Sanderson" }]);
  });

  it("does not leak Book rows into the tbr scope or GoodreadsTbrItem rows into the home/books scopes", async () => {
    await prisma.book.create({ data: { title: "Test Autocomplete Cross Scope Book" } });
    await prisma.goodreadsTbrItem.create({ data: { title: "Test Autocomplete Cross Scope Tbr" } });

    const tbrResponse = await GET(makeRequest({ scope: "tbr", q: "Test Autocomplete Cross Scope" }));
    const tbrData = await tbrResponse.json();
    expect(tbrData.map((s: { title: string }) => s.title)).toEqual([
      "Test Autocomplete Cross Scope Tbr",
    ]);

    const homeResponse = await GET(
      makeRequest({ scope: "home", q: "Test Autocomplete Cross Scope" }),
    );
    const homeData = await homeResponse.json();
    expect(homeData.map((s: { title: string }) => s.title)).toEqual([
      "Test Autocomplete Cross Scope Book",
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
});
