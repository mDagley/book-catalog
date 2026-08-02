import { prisma } from "@/lib/prisma";
import { normalizeIsbn } from "@/lib/isbn";
import { resolveListingCover } from "@/lib/listingCover";
import { letterBucket, sortLetters } from "@/lib/alphabetize";
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
  browseAll?: boolean;
  sortBy?: "id" | "title" | "author" | "createdAt" | "rating";
  // Not SQL-expressible against this schema's default collation (see the
  // module comment above resolveStartsWithIds) -- applied in JS.
  startsWith?: { letter: string; field: "title" | "author" };
  limit?: number;
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

const VALID_SORT_VALUES = ["title", "author", "createdAt", "rating"] as const;

export function parseSortParam(
  value: string | undefined,
): "title" | "author" | "createdAt" | "rating" {
  return value && (VALID_SORT_VALUES as readonly string[]).includes(value)
    ? (value as "title" | "author" | "createdAt" | "rating")
    : "title";
}

export function parseStartsWithLetter(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value === "#" || /^[A-Za-z]$/.test(value) ? value.toUpperCase() : undefined;
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

// True when neither text/ISBN search nor any filter is active and the
// caller didn't opt into browsing everything -- the historical "empty
// unfiltered home page" behavior, shared by searchCatalog, countCatalog,
// and getAvailableStartsWithLetters so all three agree on when there's
// nothing to look up.
function hasNoActiveQuery(options: SearchOptions): boolean {
  const trimmed = options.query?.trim() ?? "";
  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const statusValues = options.status && options.status.length > 0 ? options.status : undefined;
  return (
    !(options.browseAll ?? false) &&
    !trimmed &&
    !types &&
    !options.format &&
    !statusValues
  );
}

export function buildCatalogWhere(options: SearchOptions): Prisma.BookWhereInput {
  const trimmed = options.query?.trim() ?? "";
  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;
  const statusValues = options.status && options.status.length > 0 ? options.status : undefined;

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

  return { AND: filters };
}

// Secondary `id` sort breaks ties for books sharing a title -- without it,
// Postgres doesn't guarantee stable ordering among tied rows, so the same
// query could return a different order across runs as the catalog grows.
function buildOrderBy(
  sortBy: NonNullable<SearchOptions["sortBy"]>,
): Prisma.BookOrderByWithRelationInput[] {
  switch (sortBy) {
    case "title":
      return [{ title: "asc" }, { id: "asc" }];
    case "author":
      return [{ author: { sort: "asc", nulls: "last" } }, { title: "asc" }, { id: "asc" }];
    case "createdAt":
      return [{ createdAt: "desc" }, { id: "desc" }];
    case "rating":
      return [{ rating: { sort: "desc", nulls: "last" } }, { title: "asc" }, { id: "asc" }];
    case "id":
      return [{ id: "asc" }];
  }
}

function fetchBooksWithDetails(
  where: Prisma.BookWhereInput,
  orderBy: Prisma.BookOrderByWithRelationInput[],
  format: Format | undefined,
  take?: number,
) {
  return prisma.book.findMany({
    where,
    include: {
      copies: { where: format ? { format } : undefined },
      ebookCopies: { select: { coverImagePath: true } },
      audiobookCopies: { select: { coverImagePath: true } },
    },
    orderBy,
    // `take` is opt-in -- omitted entirely (rather than defaulted) so the
    // home-page search caller, which never passes it, keeps its existing
    // unlimited behavior. Validated by searchCatalog before it gets here:
    // Prisma reads a NEGATIVE take as "the last N rows", so an unvalidated
    // -5 would silently return rows from the opposite end of the ordering
    // instead of erroring (confirmed empirically).
    ...(take !== undefined ? { take } : {}),
  });
}

type BookWithDetails = Awaited<ReturnType<typeof fetchBooksWithDetails>>[number];

// A letter filter can't be pushed into the SQL WHERE clause: it depends on
// letterBucket's diacritic-stripping (see alphabetize.ts), and Postgres's
// default collation doesn't fold accents the way ILIKE would need to for
// that to work. Instead this scans a lightweight id/title/author-only
// projection (no joins -- cheap even at full-catalog scale, the same shape
// as the 3ms-median aggregate queries measured for /stats against a
// 2000-book fixture), buckets each row in JS, and returns the matching ids
// in the query's own sort order.
async function resolveStartsWithIds(
  startsWith: { letter: string; field: "title" | "author" },
  where: Prisma.BookWhereInput,
  orderBy: Prisma.BookOrderByWithRelationInput[],
): Promise<string[]> {
  const rows = await prisma.book.findMany({
    where,
    select: { id: true, title: true, author: true },
    orderBy,
  });
  return rows
    .filter(
      (row) =>
        letterBucket(startsWith.field === "title" ? row.title : (row.author ?? "")) ===
        startsWith.letter,
    )
    .map((row) => row.id);
}

export async function searchCatalog(options: SearchOptions): Promise<SearchResult[]> {
  // Throws rather than silently ignoring a bad value: dropping an invalid
  // `limit` would turn a caller bug into an unbounded full-catalog query --
  // exactly the performance problem pagination exists to prevent -- and the
  // failure would be invisible until the catalog grew large enough to hurt.
  // Validated before the early return below, so a bad `limit` throws even
  // when no query/filter is active (e.g. `searchCatalog({ limit: -5 })`).
  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`searchCatalog: limit must be a positive integer, received ${limit}`);
  }

  if (hasNoActiveQuery(options)) return [];

  const types = options.types && options.types.length > 0 ? options.types : undefined;
  const format = options.format;
  const includePhysical = !types || types.includes("physical");
  const includeEbook = !types || types.includes("ebook");
  const includeAudiobook = !types || types.includes("audiobook");

  const where = buildCatalogWhere(options);
  const orderBy = buildOrderBy(options.sortBy ?? "id");

  let books: BookWithDetails[];
  if (options.startsWith) {
    const ids = await resolveStartsWithIds(options.startsWith, where, orderBy);
    const pageIds = limit !== undefined ? ids.slice(0, limit) : ids;
    if (pageIds.length === 0) {
      books = [];
    } else {
      const rows = await fetchBooksWithDetails(
        { AND: [where, { id: { in: pageIds } }] },
        orderBy,
        format,
      );
      // Prisma's `id: { in: ... }` does not preserve the given array's
      // order, so the already-correctly-sorted `pageIds` order is restored.
      const byId = new Map(rows.map((row) => [row.id, row]));
      books = pageIds
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined);
    }
  } else {
    books = await fetchBooksWithDetails(where, orderBy, format, limit);
  }

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

export async function countCatalog(options: SearchOptions): Promise<number> {
  if (hasNoActiveQuery(options)) return 0;
  const where = buildCatalogWhere(options);
  if (options.startsWith) {
    const orderBy = buildOrderBy(options.sortBy ?? "id");
    const ids = await resolveStartsWithIds(options.startsWith, where, orderBy);
    return ids.length;
  }
  return prisma.book.count({ where });
}

// The set of letters that currently have at least one match, for rendering
// the jump-nav itself -- deliberately ignores `options.startsWith` (the
// nav must keep listing every available letter, not collapse to just the
// one currently selected).
export async function getAvailableStartsWithLetters(
  options: SearchOptions,
  field: "title" | "author",
): Promise<string[]> {
  if (hasNoActiveQuery(options)) return [];
  const where = buildCatalogWhere(options);
  const rows = await prisma.book.findMany({ where, select: { title: true, author: true } });
  const letters = new Set(
    rows.map((row) => letterBucket(field === "title" ? row.title : (row.author ?? ""))),
  );
  return sortLetters([...letters]);
}
