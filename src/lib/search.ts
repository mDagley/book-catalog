import { prisma } from "@/lib/prisma";
import { titleMatchScore, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";
import { normalizeIsbn } from "@/lib/books";
import type { Format } from "@prisma/client";

export interface SearchResultCopy {
  id: string;
  format: Format;
  publisher: string | null;
  publishYear: number | null;
}

export interface SearchResult {
  title: string;
  author: string | null;
  bookId: string | null;
  physicalCopies: SearchResultCopy[];
  hasEbook: boolean;
  hasAudiobook: boolean;
}

export async function searchCatalog(query: string): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  // Book.isbn and AbsCacheItem.isbn are always stored normalized (digits +
  // uppercase X only, no hyphens/spaces). Normalize the query the same way
  // for the ISBN clause so a hyphenated ISBN or lowercase check digit still
  // matches. Titles/authors are NOT normalized in storage, so those clauses
  // keep using the raw trimmed query.
  //
  // Only treat the query as an ISBN attempt when it's shaped like one (just
  // digits, X/x, hyphens, and whitespace) — this guards against two related
  // false-positive cases confirmed against the real dev DB:
  //   1. A query with no digits/X at all (e.g. a pure author-name search)
  //      normalizes to "" — Prisma's `contains: ""` matches every row, since
  //      every string contains the empty string.
  //   2. A natural-language query that merely happens to contain the letter
  //      "x" (e.g. "Nonexistent") normalizes to "X" — a single character
  //      that, via `contains`, false-matches any real ISBN-10 ending in the
  //      "X" check digit (confirmed live: this matched a real book whose
  //      isbn is "038561926X").
  // Restricting to isbn-shaped input up front avoids both: natural-language
  // queries never reach the ISBN clause in the first place.
  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed);
  const normalizedIsbnQuery = looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";

  const [books, absItems] = await Promise.all([
    prisma.book.findMany({
      where: {
        OR: [
          { title: { contains: trimmed, mode: "insensitive" } },
          { author: { contains: trimmed, mode: "insensitive" } },
          ...(normalizedIsbnQuery
            ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
            : []),
        ],
      },
      include: { copies: true },
      orderBy: { id: "asc" },
    }),
    prisma.absCacheItem.findMany({
      where: {
        OR: [
          { title: { contains: trimmed, mode: "insensitive" } },
          { author: { contains: trimmed, mode: "insensitive" } },
          ...(normalizedIsbnQuery
            ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
            : []),
        ],
      },
    }),
  ]);

  const results: SearchResult[] = books.map((book) => ({
    title: book.title,
    author: book.author,
    bookId: book.id,
    physicalCopies: book.copies.map((copy) => ({
      id: copy.id,
      format: copy.format,
      publisher: copy.publisher,
      publishYear: copy.publishYear,
    })),
    hasEbook: false,
    hasAudiobook: false,
  }));

  for (const item of absItems) {
    let bestMatch: SearchResult | null = null;
    let bestScore = -1;
    for (const result of results) {
      const score = titleMatchScore(result.title, item.title);
      if (score >= DEFAULT_MATCH_THRESHOLD && score > bestScore) {
        bestMatch = result;
        bestScore = score;
      }
    }
    if (bestMatch) {
      if (item.mediaType === "EBOOK") bestMatch.hasEbook = true;
      if (item.mediaType === "AUDIOBOOK") bestMatch.hasAudiobook = true;
    } else {
      results.push({
        title: item.title,
        author: item.author,
        bookId: null,
        physicalCopies: [],
        hasEbook: item.mediaType === "EBOOK",
        hasAudiobook: item.mediaType === "AUDIOBOOK",
      });
    }
  }

  return results;
}
