-- CreateTable
CREATE TABLE "EbookCopy" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "absItemId" TEXT NOT NULL,
    "coverImagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EbookCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudiobookCopy" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "absItemId" TEXT NOT NULL,
    "coverImagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudiobookCopy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Each ABS item ID identifies exactly one real Audiobookshelf library item,
-- so it must map to at most one copy row system-wide (not just one per
-- book) -- this is what stops absSync.ts from ever creating two rows for
-- the same item, whether via a stale link, a concurrent sync run, or a
-- duplicate entry in the pre-migration array data below.
CREATE UNIQUE INDEX "EbookCopy_absItemId_key" ON "EbookCopy"("absItemId");

-- CreateIndex
CREATE UNIQUE INDEX "AudiobookCopy_absItemId_key" ON "AudiobookCopy"("absItemId");

-- Backfill: convert each existing array entry into a real row before the
-- array columns are dropped below. gen_random_uuid() is used for these
-- rows' ids (not Prisma's application-level cuid()) since a raw SQL
-- migration has no access to Prisma's id generator -- this is safe, since
-- nothing validates the *format* of an existing row's id, only that it's a
-- unique string primary key. Every row the application creates from this
-- point forward still gets a real cuid() via Prisma Client as normal.
--
-- DISTINCT ON "item" guards against the new unique index above: if the same
-- ABS item ID somehow appeared in more than one Book's array (a pre-existing
-- data anomaly the old array-based code never prevented across different
-- Books), this keeps only the row for the oldest Book (matching the
-- "oldest Book wins" convention already used for ISBN matches elsewhere in
-- this codebase) instead of failing the whole migration with a constraint
-- violation.
INSERT INTO "EbookCopy" ("id", "bookId", "absItemId", "createdAt")
SELECT DISTINCT ON ("item")
  gen_random_uuid()::text, "Book"."id", "item", COALESCE("Book"."lastAbsSyncedAt", CURRENT_TIMESTAMP)
FROM "Book", unnest("Book"."absEbookItemIds") AS "item"
ORDER BY "item", "Book"."createdAt" ASC;

INSERT INTO "AudiobookCopy" ("id", "bookId", "absItemId", "createdAt")
SELECT DISTINCT ON ("item")
  gen_random_uuid()::text, "Book"."id", "item", COALESCE("Book"."lastAbsSyncedAt", CURRENT_TIMESTAMP)
FROM "Book", unnest("Book"."absAudiobookItemIds") AS "item"
ORDER BY "item", "Book"."createdAt" ASC;

-- AlterTable
ALTER TABLE "Book" DROP COLUMN "absAudiobookItemIds",
DROP COLUMN "absEbookItemIds";

-- AddForeignKey
ALTER TABLE "EbookCopy" ADD CONSTRAINT "EbookCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudiobookCopy" ADD CONSTRAINT "AudiobookCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
