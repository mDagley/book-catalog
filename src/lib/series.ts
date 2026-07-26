// Parses Goodreads' long-standing "Title (Series Name, #N)" title convention.
//
// Deliberately Prisma-free (like src/lib/isbn.ts) so it can be imported from
// anywhere, including client components, without dragging in the database
// client.
//
// Goodreads' RSS feed exposes no structured series field -- confirmed by
// fetching a real shelf feed during design -- so the title string is the only
// available source. See
// docs/superpowers/specs/2026-07-20-series-tracking-design.md.
//
// The same pattern is expressed as SQL in the migration that backfills
// existing rows. That duplication is safe because a migration runs once and
// is then frozen; the two only need to agree at the moment it applies.
const SERIES_SUFFIX = /^(.+) \(([^,()]+), #(\d+(?:\.\d+)?)\)$/;

export interface ParsedSeries {
  seriesName: string;
  seriesPosition: number;
}

export function parseSeriesFromTitle(title: string): ParsedSeries | null {
  const match = SERIES_SUFFIX.exec(title);
  if (!match) return null;
  const seriesName = match[2].trim();
  if (!seriesName) return null;
  return { seriesName, seriesPosition: Number.parseFloat(match[3]) };
}

export interface SeriesMember {
  id: string;
  title: string;
  seriesPosition: number | null;
}

// Position ascending, with un-numbered entries after every numbered one and
// ties broken by title.
//
// Sorted here rather than in the Prisma query for two reasons: "nulls last"
// ordering support varies across Prisma versions, and a series is small
// enough that in-memory sorting costs nothing. Keeping it as a pure exported
// function also makes the rule directly testable -- a near-identical ordering
// bug on /stats (ranked lists reshuffling between page loads because ties had
// no secondary key) shipped past a full unit-test suite and was only caught
// by loading the page twice.
//
// Copies before sorting: Array.prototype.sort mutates in place, and the
// caller's array here comes straight from a Prisma result that other code
// may still read.
export function sortSeriesMembers<T extends SeriesMember>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    if (a.seriesPosition === null && b.seriesPosition === null) {
      return a.title.localeCompare(b.title);
    }
    if (a.seriesPosition === null) return 1;
    if (b.seriesPosition === null) return -1;
    if (a.seriesPosition !== b.seriesPosition) return a.seriesPosition - b.seriesPosition;
    return a.title.localeCompare(b.title);
  });
}
