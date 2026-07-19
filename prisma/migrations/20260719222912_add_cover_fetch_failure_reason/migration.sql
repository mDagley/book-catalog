-- AlterTable
ALTER TABLE "AudiobookCopy" ADD COLUMN     "coverFetchFailureReason" TEXT;

-- AlterTable
ALTER TABLE "EbookCopy" ADD COLUMN     "coverFetchFailureReason" TEXT;

-- AlterTable
ALTER TABLE "GoodreadsTbrItem" ADD COLUMN     "coverFetchFailureReason" TEXT;
