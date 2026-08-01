-- CreateIndex
CREATE INDEX "AudiobookCopy_bookId_idx" ON "AudiobookCopy"("bookId");

-- CreateIndex
CREATE INDEX "Book_isbn_idx" ON "Book"("isbn");

-- CreateIndex
CREATE INDEX "EbookCopy_bookId_idx" ON "EbookCopy"("bookId");

-- CreateIndex
CREATE INDEX "PhysicalCopy_bookId_idx" ON "PhysicalCopy"("bookId");
