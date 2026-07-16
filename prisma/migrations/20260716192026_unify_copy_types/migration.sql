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

-- Backfill: convert each existing array entry into a real row before the
-- array columns are dropped below. gen_random_uuid() is used for these
-- rows' ids (not Prisma's application-level cuid()) since a raw SQL
-- migration has no access to Prisma's id generator -- this is safe, since
-- nothing validates the *format* of an existing row's id, only that it's a
-- unique string primary key. Every row the application creates from this
-- point forward still gets a real cuid() via Prisma Client as normal.
INSERT INTO "EbookCopy" ("id", "bookId", "absItemId", "createdAt")
SELECT gen_random_uuid()::text, "Book"."id", "item", COALESCE("Book"."lastAbsSyncedAt", CURRENT_TIMESTAMP)
FROM "Book", unnest("Book"."absEbookItemIds") AS "item";

INSERT INTO "AudiobookCopy" ("id", "bookId", "absItemId", "createdAt")
SELECT gen_random_uuid()::text, "Book"."id", "item", COALESCE("Book"."lastAbsSyncedAt", CURRENT_TIMESTAMP)
FROM "Book", unnest("Book"."absAudiobookItemIds") AS "item";

-- AlterTable
ALTER TABLE "Book" DROP COLUMN "absAudiobookItemIds",
DROP COLUMN "absEbookItemIds";

-- AddForeignKey
ALTER TABLE "EbookCopy" ADD CONSTRAINT "EbookCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudiobookCopy" ADD CONSTRAINT "AudiobookCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
