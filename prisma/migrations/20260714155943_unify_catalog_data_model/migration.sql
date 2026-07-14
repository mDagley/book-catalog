-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "absAudiobookItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "absEbookItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "hasAudiobook" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasEbook" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastAbsSyncedAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "AbsCacheItem";

-- DropEnum
DROP TYPE "MediaType";

