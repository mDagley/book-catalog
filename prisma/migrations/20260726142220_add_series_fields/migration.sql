-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "seriesManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seriesName" TEXT,
ADD COLUMN     "seriesPosition" DOUBLE PRECISION;

-- Backfill: derive series from Goodreads' "Title (Series Name, #N)" title
-- convention for every pre-existing row. Done here as pure SQL rather than a
-- separate script or an admin button, so it applies automatically wherever
-- migrations run (docker-entrypoint.sh runs `prisma migrate deploy` at
-- container startup) and needs no manual production step.
--
-- regexp_match returns NULL when the pattern doesn't match, so rows that
-- don't follow the convention are simply left alone. Verified against the
-- spec's own cases: "(Annotated Edition)" and "(Something, No Number)" both
-- correctly fail to match.
--
-- This mirrors parseSeriesFromTitle in src/lib/series.ts, which handles every
-- row created from here on. Having the pattern twice is safe precisely
-- because this statement runs exactly once and is then frozen.
--
-- seriesManual is deliberately left at its false default: nothing here is a
-- hand-edit.
UPDATE "Book" AS b
SET "seriesName" = btrim(sub.m[2]),
    "seriesPosition" = sub.m[3]::double precision
FROM (
  SELECT id, regexp_match(title, '^(.+) \(([^,()]+), #([0-9]+(\.[0-9]+)?)\)$') AS m
  FROM "Book"
) AS sub
WHERE b.id = sub.id
  AND sub.m IS NOT NULL
  AND btrim(sub.m[2]) <> '';
