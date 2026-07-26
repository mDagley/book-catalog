import { prisma } from "@/lib/prisma";

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
  ]);

  return {
    totals: {
      books,
      copies: physicalCopies + ebookCopies + audiobookCopies,
      physicalBooks,
      ebookBooks,
      audiobookBooks,
      multiFormatBooks: multiFormatRows[0]?.count ?? 0,
    },
    readStatus: [],
    ratings: [],
    formats: [],
    topPublishers: [],
    decades: [],
    publishYearUnknown: 0,
    topAuthors: [],
    tbr: { total: 0, owned: 0, gap: 0 },
  };
}
