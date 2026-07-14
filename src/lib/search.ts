import { prisma } from "@/lib/prisma";
import { titleMatchScore, DEFAULT_MATCH_THRESHOLD } from "@/lib/matching";
import { normalizeIsbn } from "@/lib/books";
import type { Format, MediaType } from "@prisma/client";

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

export type OwnershipType = "physical" | "ebook" | "audiobook";

export interface SearchOptions {
  query?: string;
  types?: OwnershipType[];
  format?: Format;
}

const VALID_FORMATS: readonly string[] = ["HARDCOVER", "PAPERBACK", "MASS_MARKET", "OTHER"];
const VALID_TYPES: readonly string[] = ["physical", "ebook", "audiobook"];

export function parseFormatParam(value: string | undefined): Format | undefined {
  if (!value) return undefined;
  return VALID_FORMATS.includes(value) ? (value as Format) : undefined;
}

export function parseTypesParam(
  value: string | string[] | undefined,
): OwnershipType[] | undefined {
  if (!value) return undefined;
  const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",");
  const parsed = tokens
    .map((t) => t.trim())
    .filter((t): t is OwnershipType => VALID_TYPES.includes(t));
  return parsed.length > 0 ? parsed : undefined;
}

export async function searchCatalog(options: SearchOptions): Promise<SearchResult[]> {
  const trimmed = options.query?.trim() ?? "";
  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;

  if (!trimmed && !types && !format) return [];

  const includePhysical = !types || types.includes("physical");
  const includeEbook = !types || types.includes("ebook");
  const includeAudiobook = !types || types.includes("audiobook");

  // Only require an existing physical copy when the user actively asked for
  // a physical-ownership view (an explicit "physical" type filter, or a
  // format filter) -- NOT for a fully unfiltered/default search. A copyless
  // Book row is a real, reachable state (deleteCopyData never cascades to
  // delete the parent Book), and for a plain unfiltered query it should
  // still surface bare (no physical badge, since its copies array is
  // empty) exactly as it did before this feature existed -- it's only
  // wrong to include it under an EXPLICIT physical-ownership filter, which
  // is a stronger claim ("you own this physically") a copyless book can't
  // back up.
  const explicitPhysicalFilterActive =
    format !== undefined || (types !== undefined && types.includes("physical"));

  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed);
  const normalizedIsbnQuery = trimmed && looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";

  const mediaTypesToFetch: MediaType[] = [];
  if (includeEbook) mediaTypesToFetch.push("EBOOK");
  if (includeAudiobook) mediaTypesToFetch.push("AUDIOBOOK");

  const [books, absItems] = await Promise.all([
    includePhysical
      ? prisma.book.findMany({
          where: {
            ...(trimmed
              ? {
                  OR: [
                    { title: { contains: trimmed, mode: "insensitive" as const } },
                    { author: { contains: trimmed, mode: "insensitive" as const } },
                    ...(normalizedIsbnQuery
                      ? [
                          {
                            isbn: {
                              contains: normalizedIsbnQuery,
                              mode: "insensitive" as const,
                            },
                          },
                        ]
                      : []),
                  ],
                }
              : {}),
            ...(explicitPhysicalFilterActive
              ? { copies: format ? { some: { format } } : { some: {} } }
              : {}),
          },
          include: {
            copies: { where: format ? { format } : undefined },
          },
          orderBy: { id: "asc" },
        })
      : Promise.resolve([]),
    mediaTypesToFetch.length > 0
      ? prisma.absCacheItem.findMany({
          where: {
            ...(trimmed
              ? {
                  OR: [
                    { title: { contains: trimmed, mode: "insensitive" as const } },
                    { author: { contains: trimmed, mode: "insensitive" as const } },
                    ...(normalizedIsbnQuery
                      ? [
                          {
                            isbn: {
                              contains: normalizedIsbnQuery,
                              mode: "insensitive" as const,
                            },
                          },
                        ]
                      : []),
                  ],
                }
              : {}),
            mediaType: { in: mediaTypesToFetch },
          },
        })
      : Promise.resolve([]),
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
