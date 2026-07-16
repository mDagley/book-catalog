-- CreateEnum
CREATE TYPE "ReadStatus" AS ENUM ('TO_READ', 'READING', 'READ');

-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "rating" INTEGER,
ADD COLUMN     "ratingManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "readStatus" "ReadStatus",
ADD COLUMN     "readStatusManual" BOOLEAN NOT NULL DEFAULT false;

