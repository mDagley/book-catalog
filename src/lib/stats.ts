import { prisma } from "@/lib/prisma";
import type { Format, ReadStatus } from "@prisma/client";

// groupBy only returns buckets that actually have rows, so every
// distribution is projected onto a fixed, ordered bucket list. Without this
// a category with zero books silently vanishes from the page instead of
// showing an empty bar -- and "no books are currently being read" is
// information worth rendering.
const READ_STATUS_BUCKETS: { label: string; value: ReadStatus | null }[] = [
  { label: "Read", value: "READ" },
  { label: "Reading", value: "READING" },
  { label: "To read", value: "TO_READ" },
  // A book never touched by a Goodreads shelf sync has no status at all.
  // That is genuinely different from "to read" and is shown as its own
  // bucket rather than folded in.
  { label: "No status", value: null },
];

const RATING_BUCKETS: { label: string; value: number | null }[] = [
  { label: "5 stars", value: 5 },
  { label: "4 stars", value: 4 },
  { label: "3 stars", value: 3 },
  { label: "2 stars", value: 2 },
  { label: "1 star", value: 1 },
  { label: "Unrated", value: null },
];

const FORMAT_BUCKETS: { label: string; value: Format }[] = [
  { label: "Hardcover", value: "HARDCOVER" },
  { label: "Paperback", value: "PAPERBACK" },
  { label: "Mass market", value: "MASS_MARKET" },
  { label: "Other", value: "OTHER" },
];

// How many publishers/authors the ranked lists show. Ten keeps the lists
// readable; the visualization guidance treats more than ~7 colour-coded
// classes as a table, but these are single-hue ranked bars where length
// carries the data, so a longer list stays legible.
const TOP_N = 10;

export interface CountBucket {
  label: string;
  count: number;
}

export interface LibraryStats {
  totals: {
    books: number;
    copies: number;
    physicalBooks: number;
    ebookBooks: number;
    audiobookBooks: number;
    multiFormatBooks: number;
  };
  readStatus: CountBucket[];
  ratings: CountBucket[];
  formats: CountBucket[];
  topPublishers: CountBucket[];
  decades: CountBucket[];
  publishYearUnknown: number;
  topAuthors: CountBucket[];
  tbr: { total: number; owned: number; gap: number };
}

// Every figure here is a COUNT or GROUP BY executed inside Postgres --
// measured at 38ms for the whole batch against 2000 books, which is why this
// page has no cache and no persisted stats table. See
// docs/superpowers/specs/2026-07-26-library-stats-design.md for why that
// deliberately differs from the TBR gap's persisted-column approach: the
// preference is against expensive RECOMPUTATION (fuzzy matching in app
// code), not against computation.
export async function getLibraryStats(): Promise<LibraryStats> {
  const [
    books,
    physicalCopies,
    ebookCopies,
    audiobookCopies,
    physicalBooks,
    ebookBooks,
    audiobookBooks,
    multiFormatRows,
    readStatusGroups,
    ratingGroups,
    formatGroups,
    publisherGroups,
    decadeRows,
    publishYearUnknown,
  ] = await Promise.all([
    prisma.book.count(),
    prisma.physicalCopy.count(),
    prisma.ebookCopy.count(),
    prisma.audiobookCopy.count(),
    prisma.book.count({ where: { copies: { some: {} } } }),
    prisma.book.count({ where: { hasEbook: true } }),
    prisma.book.count({ where: { hasAudiobook: true } }),
    // Counts a book as multi-format when at least two of the three ownership
    // signals are present. Done in SQL rather than by pulling every book into
    // memory -- COUNT(*)::int (not bare COUNT(*)) because Postgres returns
    // bigint for the latter, which breaks arithmetic and serialization.
    prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM "Book" b
      WHERE (
        (CASE WHEN b."hasEbook" THEN 1 ELSE 0 END) +
        (CASE WHEN b."hasAudiobook" THEN 1 ELSE 0 END) +
        (CASE WHEN EXISTS (SELECT 1 FROM "PhysicalCopy" p WHERE p."bookId" = b.id) THEN 1 ELSE 0 END)
      ) >= 2
    `,
    prisma.book.groupBy({ by: ["readStatus"], _count: { _all: true } }),
    prisma.book.groupBy({ by: ["rating"], _count: { _all: true } }),
    prisma.physicalCopy.groupBy({ by: ["format"], _count: { _all: true } }),
    prisma.physicalCopy.groupBy({
      by: ["publisher"],
      where: { publisher: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { publisher: "desc" } },
      take: TOP_N,
    }),
    // Decade bucketing has no Prisma equivalent, so raw SQL. COUNT(*)::int,
    // not COUNT(*) -- Postgres returns bigint otherwise, which is not JSON
    // serializable out of a server component.
    prisma.$queryRaw<{ decade: number; count: number }[]>`
      SELECT (("publishYear" / 10) * 10)::int AS decade, COUNT(*)::int AS count
      FROM "PhysicalCopy"
      WHERE "publishYear" IS NOT NULL
      GROUP BY decade
      ORDER BY decade
    `,
    prisma.physicalCopy.count({ where: { publishYear: null } }),
  ]);

  const readStatus = READ_STATUS_BUCKETS.map(({ label, value }) => ({
    label,
    count: readStatusGroups.find((g) => g.readStatus === value)?._count._all ?? 0,
  }));

  const ratings = RATING_BUCKETS.map(({ label, value }) => ({
    label,
    count: ratingGroups.find((g) => g.rating === value)?._count._all ?? 0,
  }));

  const formats = FORMAT_BUCKETS.map(({ label, value }) => ({
    label,
    count: formatGroups.find((g) => g.format === value)?._count._all ?? 0,
  }));

  // `publisher` is filtered non-null in the query, so the cast is safe --
  // Prisma still types the groupBy key as nullable.
  const topPublishers = publisherGroups.map((g) => ({
    label: g.publisher as string,
    count: g._count._all,
  }));

  // Only decades that actually have copies are listed. Unlike the fixed
  // bucket lists above, the range here is open-ended and data-dependent --
  // padding every empty decade between the oldest and newest book would add
  // noise, not information.
  const decades = decadeRows.map((row) => ({
    label: `${row.decade}s`,
    count: row.count,
  }));

  return {
    totals: {
      books,
      copies: physicalCopies + ebookCopies + audiobookCopies,
      physicalBooks,
      ebookBooks,
      audiobookBooks,
      multiFormatBooks: multiFormatRows[0]?.count ?? 0,
    },
    readStatus,
    ratings,
    formats,
    topPublishers,
    decades,
    publishYearUnknown,
    topAuthors: [],
    tbr: { total: 0, owned: 0, gap: 0 },
  };
}
