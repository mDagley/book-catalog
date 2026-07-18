-- AlterTable
ALTER TABLE "AudiobookCopy" ADD COLUMN     "coverCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EbookCopy" ADD COLUMN     "coverCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GoodreadsTbrItem" ADD COLUMN     "coverCheckedAt" TIMESTAMP(3),
ADD COLUMN     "coverImagePath" TEXT;
