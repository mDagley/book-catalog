-- AlterTable
ALTER TABLE "Book" ADD COLUMN     "duplicateGroupId" TEXT;

-- CreateTable
CREATE TABLE "DuplicateGroup" (
    "id" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateDetectionRun" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DuplicateDetectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Book_duplicateGroupId_idx" ON "Book"("duplicateGroupId");

-- AddForeignKey
ALTER TABLE "Book" ADD CONSTRAINT "Book_duplicateGroupId_fkey" FOREIGN KEY ("duplicateGroupId") REFERENCES "DuplicateGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
