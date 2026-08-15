import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverGridCard } from "@/components/CoverGridCard";
import type { SearchResult } from "@/lib/search";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: "Test Book",
    author: "Test Author",
    bookId: "book-1",
    physicalCopies: [],
    hasEbook: false,
    hasAudiobook: false,
    readStatus: null,
    rating: null,
    coverImagePath: null,
    ...overrides,
  };
}

describe("CoverGridCard", () => {
  it("renders the placeholder tile when there is no cover", () => {
    const html = renderToStaticMarkup(<CoverGridCard result={makeResult()} />);
    expect(html).toContain("📖"); // 📖
    expect(html).not.toContain("<img");
  });

  it("renders the cover image when a cover path is set", () => {
    const html = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ coverImagePath: "abc.jpg" })} />,
    );
    expect(html).toContain("/api/covers/abc.jpg");
  });

  it("renders the Read badge only when readStatus is READ", () => {
    const read = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ readStatus: "READ" })} />,
    );
    const unread = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ readStatus: "TO_READ" })} />,
    );
    expect(read).toContain("Read");
    expect(unread).not.toContain(">Read<");
  });

  it("renders one format badge per owned format", () => {
    const html = renderToStaticMarkup(
      <CoverGridCard
        result={makeResult({
          physicalCopies: [{ id: "c1", format: "HARDCOVER", publisher: null, publishYear: null }],
          hasEbook: true,
          hasAudiobook: true,
        })}
      />,
    );
    expect(html).toContain("Physical copy");
    expect(html).toContain("Ebook");
    expect(html).toContain("Audiobook");
  });

  it("wraps the card in a link to the book when bookId is present", () => {
    const html = renderToStaticMarkup(<CoverGridCard result={makeResult()} />);
    expect(html).toContain('href="/books/book-1"');
  });

  it("shows title and author as text below the cover", () => {
    const html = renderToStaticMarkup(
      <CoverGridCard result={makeResult({ title: "Dune", author: "Frank Herbert" })} />,
    );
    expect(html).toContain("Dune");
    expect(html).toContain("Frank Herbert");
  });
});
