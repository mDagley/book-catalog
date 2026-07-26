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
