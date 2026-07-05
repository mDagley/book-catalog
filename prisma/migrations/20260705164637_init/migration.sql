-- CreateEnum
CREATE TYPE "Format" AS ENUM ('HARDCOVER', 'PAPERBACK', 'MASS_MARKET', 'OTHER');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('EBOOK', 'AUDIOBOOK');

-- CreateTable
CREATE TABLE "Book" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "isbn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalCopy" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "format" "Format" NOT NULL,
    "publisher" TEXT,
    "publishYear" INTEGER,
    "specialNotes" TEXT,
    "coverImagePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhysicalCopy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbsCacheItem" (
    "id" TEXT NOT NULL,
    "absItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "isbn" TEXT,
    "mediaType" "MediaType" NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbsCacheItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodreadsTbrItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "isbn" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodreadsTbrItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AbsCacheItem_absItemId_key" ON "AbsCacheItem"("absItemId");

-- AddForeignKey
ALTER TABLE "PhysicalCopy" ADD CONSTRAINT "PhysicalCopy_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
