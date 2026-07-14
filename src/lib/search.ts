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

// Book and AbsCacheItem both have title/author/isbn string fields, so this
// clause is shared between their two queries below rather than duplicated.
function textQueryWhere(trimmed: string, normalizedIsbnQuery: string) {
  if (!trimmed) return {};
  return {
    OR: [
      { title: { contains: trimmed, mode: "insensitive" as const } },
      { author: { contains: trimmed, mode: "insensitive" as const } },
      ...(normalizedIsbnQuery
        ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
        : []),
    ],
  };
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
  // Book row isn't reachable through the app's own UI today (deleteCopyData,
  // src/lib/copies.ts, cascades to delete the parent Book once its last
  // copy is gone) -- but this guard is still worth keeping defensively
  // (e.g. against a future change to that cascade, or any other path that
  // might leave a Book with zero copies) since including such a row under
  // an EXPLICIT physical-ownership filter would be a stronger claim ("you
  // own this physically") than an empty copies array can back up. For a
  // plain unfiltered query, a hypothetical copyless book should still
  // surface bare (no physical badge) exactly as it did before this feature
  // existed -- that's the only reason this guard is conditional rather than
  // unconditional.
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
            ...textQueryWhere(trimmed, normalizedIsbnQuery),
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
            ...textQueryWhere(trimmed, normalizedIsbnQuery),
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

  // Scan only the fixed-size physical-books subset (`results`) below, not a
  // growing combined array -- absItems are only ever meant to merge into an
  // EXISTING physical-book entry, never into another, previously-appended
  // absItem-only entry. Appending unmatched items straight into `results`
  // and rescanning that same (now-longer) array on every later iteration
  // would make this loop O(n^2) in the number of unmatched absItems (which
  // realistically dominates for a broad, mostly-text-query-free browse --
  // e.g. filtering by format alone pulls in the whole AbsCacheItem table),
  // and could spuriously fuzzy-match two unrelated absItem-only entries
  // against each other, which was never intended.
  const standaloneAbsResults: SearchResult[] = [];
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
      standaloneAbsResults.push({
        title: item.title,
        author: item.author,
        bookId: null,
        physicalCopies: [],
        hasEbook: item.mediaType === "EBOOK",
        hasAudiobook: item.mediaType === "AUDIOBOOK",
      });
    }
  }

  return [...results, ...standaloneAbsResults];
}
