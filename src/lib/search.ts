import { prisma } from "@/lib/prisma";
import { normalizeIsbn } from "@/lib/books";
import { resolveListingCover } from "@/lib/listingCover";
import type { Format, Prisma, ReadStatus } from "@prisma/client";

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
  readStatus: ReadStatus | null;
  rating: number | null;
  coverImagePath: string | null;
}

export type OwnershipType = "physical" | "ebook" | "audiobook";

export interface SearchOptions {
  query?: string;
  types?: OwnershipType[];
  format?: Format;
  status?: ReadStatusFilterValue[];
  statusMode?: StatusFilterMode;
}

export type ReadStatusFilterValue = "to_read" | "reading" | "read" | "unrated";
export type StatusFilterMode = "or" | "and";

// `as const satisfies` ties each literal to the real type, so a typo (e.g.
// "PAPERBAK") fails to compile instead of silently being an always-false
// check at runtime. Cast back to `readonly string[]` at the `.includes()`
// call sites below, since the incoming value being checked is a generic
// string (from a URL param), not already narrowed to the literal union.
const VALID_FORMATS = ["HARDCOVER", "PAPERBACK", "MASS_MARKET", "OTHER"] as const satisfies readonly Format[];
const VALID_TYPES = ["physical", "ebook", "audiobook"] as const satisfies readonly OwnershipType[];
const VALID_STATUS_VALUES = [
  "to_read",
  "reading",
  "read",
  "unrated",
] as const satisfies readonly ReadStatusFilterValue[];

const STATUS_VALUE_TO_ENUM: Record<Exclude<ReadStatusFilterValue, "unrated">, ReadStatus> = {
  to_read: "TO_READ",
  reading: "READING",
  read: "READ",
};

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

export function parseStatusParam(
  value: string | string[] | undefined,
): ReadStatusFilterValue[] | undefined {
  if (!value) return undefined;
  const tokens = Array.isArray(value) ? value.flatMap((v) => v.split(",")) : value.split(",");
  const parsed = tokens
    .map((t) => t.trim())
    .filter((t): t is ReadStatusFilterValue => (VALID_STATUS_VALUES as readonly string[]).includes(t));
  return parsed.length > 0 ? parsed : undefined;
}

// Defaults to "or" (the pre-existing behavior) for anything not exactly
// "and" -- missing, malformed, or unrecognized values all fall back to the
// same safe default rather than erroring.
export function parseStatusModeParam(value: string | undefined): StatusFilterMode {
  return value === "and" ? "and" : "or";
}

// "and" is meaningful when combining a status with "unrated" (e.g.
// "reading AND unrated"); ANDing two distinct readStatus values together
// isn't a separate case to guard against -- a Book's readStatus is a
// single column, so requiring it to equal two different values at once
// naturally (and correctly) matches nothing at the SQL level, with no
// special-casing needed here.
export function buildStatusWhere(
  statusValues: ReadStatusFilterValue[] | undefined,
  statusMode: StatusFilterMode,
): Prisma.BookWhereInput | undefined {
  if (!statusValues || statusValues.length === 0) return undefined;
  const statusConditions: Prisma.BookWhereInput[] = statusValues.map((value) =>
    value === "unrated" ? { rating: null } : { readStatus: STATUS_VALUE_TO_ENUM[value] },
  );
  return statusMode === "and" ? { AND: statusConditions } : { OR: statusConditions };
}

export async function searchCatalog(options: SearchOptions): Promise<SearchResult[]> {
  const trimmed = options.query?.trim() ?? "";
  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;
  const statusValues = options.status && options.status.length > 0 ? options.status : undefined;

  if (!trimmed && !types && !format && !statusValues) return [];

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
  // surface any matching Book regardless of ownership. This isn't reachable
  // through the app's own UI today -- every Book-creation path
  // (createBookWithCopyData, and absSync.ts's link/create logic) always sets
  // at least one ownership signal -- but the guard is kept defensively
  // against a future change to those invariants, the same as the
  // pre-unification default browse, which never required ownership absent an
  // explicit filter (see the old `explicitPhysicalFilterActive` guard this
  // replaces and generalizes).
  const explicitOwnershipFilterActive = types !== undefined || format !== undefined;
  const filters: Prisma.BookWhereInput[] = [];
  if (explicitOwnershipFilterActive) {
    const ownershipOr: Prisma.BookWhereInput[] = [];
    if (includePhysical) {
      ownershipOr.push({ copies: format ? { some: { format } } : { some: {} } });
    }
    if (includeEbook) ownershipOr.push({ hasEbook: true });
    if (includeAudiobook) ownershipOr.push({ hasAudiobook: true });
    filters.push({ OR: ownershipOr });
  }
  const statusWhere = buildStatusWhere(statusValues, options.statusMode ?? "or");
  if (statusWhere) filters.push(statusWhere);
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
    include: {
      copies: { where: format ? { format } : undefined },
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy: { id: "asc" },
  });

  return books.map((book) => ({
    title: book.title,
    author: book.author,
    bookId: book.id,
    // Forced empty/false (not just unfiltered) when a given ownership type
    // isn't part of the requested view -- `types` controls which ownership
    // badges/details show at all, so e.g. an ebook-only view should never
    // surface a "Physical (...)" or "Audiobook (...)" badge even for a book
    // that also happens to be owned in those other forms. Matches the
    // pre-unification dual-query implementation's own behavior (its
    // ABS-item query only ever fetched items for media types actually
    // included in the filter, so an excluded type's flag could never come
    // back true).
    physicalCopies: includePhysical
      ? book.copies.map((copy) => ({
          id: copy.id,
          format: copy.format,
          publisher: copy.publisher,
          publishYear: copy.publishYear,
        }))
      : [],
    hasEbook: includeEbook ? book.hasEbook : false,
    hasAudiobook: includeAudiobook ? book.hasAudiobook : false,
    readStatus: book.readStatus,
    rating: book.rating,
    coverImagePath: resolveListingCover(book),
  }));
}
