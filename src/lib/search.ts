import { prisma } from "@/lib/prisma";
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
  bookId: string;
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

// `as const satisfies` ties each literal to the real type, so a typo (e.g.
// "PAPERBAK") fails to compile instead of silently being an always-false
// check at runtime. Cast back to `readonly string[]` at the `.includes()`
// call sites below, since the incoming value being checked is a generic
// string (from a URL param), not already narrowed to the literal union.
const VALID_FORMATS = ["HARDCOVER", "PAPERBACK", "MASS_MARKET", "OTHER"] as const satisfies readonly Format[];
const VALID_TYPES = ["physical", "ebook", "audiobook"] as const satisfies readonly OwnershipType[];

export function parseFormatParam(value: string | undefined): Format | undefined {
  if (!value) return undefined;
  return (VALID_FORMATS as readonly string[]).includes(value) ? (value as Format) : undefined;
}

export function parseTypesParam(
  value: string | string[] | undefined,
): OwnershipType[] | undefined {
  if (!value) return undefined;
  const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",");
  const parsed = tokens
    .map((t) => t.trim())
    .filter((t): t is OwnershipType => (VALID_TYPES as readonly string[]).includes(t));
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

  const looksLikeIsbnQuery = /^[0-9Xx\s-]+$/.test(trimmed);
  const normalizedIsbnQuery = trimmed && looksLikeIsbnQuery ? normalizeIsbn(trimmed) : "";

  // Every included ownership type ORs together into one clause -- a Book
  // matches if it satisfies ANY currently-included type. `format` narrows
  // only the physical branch; an ebook/audiobook result is unaffected by it,
  // since format is a physical-copy-only concept (matches the pre-unification
  // behavior, where format never gated the separate ABS-item query either).
  //
  // This ownership OR is only applied as a required filter when the caller
  // explicitly asked for an ownership-narrowed view (a `types` filter and/or
  // a `format` filter). A plain, unfiltered text/ISBN search should still
  // surface any matching Book regardless of ownership -- e.g. a freshly
  // catalogued book with no copies and no ebook/audiobook flags yet -- the
  // same as the pre-unification default browse, which never required
  // ownership absent an explicit filter (see the old `explicitPhysicalFilterActive`
  // guard this replaces and generalizes).
  const explicitOwnershipFilterActive = types !== undefined || format !== undefined;
  const filters: object[] = [];
  if (explicitOwnershipFilterActive) {
    const ownershipOr: object[] = [];
    if (includePhysical) {
      ownershipOr.push({ copies: format ? { some: { format } } : { some: {} } });
    }
    if (includeEbook) ownershipOr.push({ hasEbook: true });
    if (includeAudiobook) ownershipOr.push({ hasAudiobook: true });
    filters.push({ OR: ownershipOr });
  }
  if (trimmed) {
    filters.push({
      OR: [
        { title: { contains: trimmed, mode: "insensitive" as const } },
        { author: { contains: trimmed, mode: "insensitive" as const } },
        ...(normalizedIsbnQuery
          ? [{ isbn: { contains: normalizedIsbnQuery, mode: "insensitive" as const } }]
          : []),
      ],
    });
  }

  const books = await prisma.book.findMany({
    where: { AND: filters },
    include: { copies: { where: includePhysical && format ? { format } : undefined } },
    orderBy: { id: "asc" },
  });

  return books.map((book) => ({
    title: book.title,
    author: book.author,
    bookId: book.id,
    physicalCopies: book.copies.map((copy) => ({
      id: copy.id,
      format: copy.format,
      publisher: copy.publisher,
      publishYear: copy.publishYear,
    })),
    hasEbook: book.hasEbook,
    hasAudiobook: book.hasAudiobook,
  }));
}
