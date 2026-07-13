import { prisma } from "@/lib/prisma";
import { isTitleMatch } from "@/lib/matching";
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

  const [books, absItems] = await Promise.all([
    prisma.book.findMany({
      where: {
        OR: [
          { title: { contains: trimmed, mode: "insensitive" } },
          { author: { contains: trimmed, mode: "insensitive" } },
          { isbn: { contains: trimmed, mode: "insensitive" } },
        ],
      },
      include: { copies: true },
    }),
    prisma.absCacheItem.findMany({
      where: {
        OR: [
          { title: { contains: trimmed, mode: "insensitive" } },
          { author: { contains: trimmed, mode: "insensitive" } },
          { isbn: { contains: trimmed, mode: "insensitive" } },
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
    const existing = results.find((r) => isTitleMatch(r.title, item.title));
    if (existing) {
      if (item.mediaType === "EBOOK") existing.hasEbook = true;
      if (item.mediaType === "AUDIOBOOK") existing.hasAudiobook = true;
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
