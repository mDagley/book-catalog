-- CreateTable
CREATE TABLE "RetailerMatch" (
    "id" TEXT NOT NULL,
    "tbrItemId" TEXT NOT NULL,
    "retailer" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "matchedTitle" TEXT NOT NULL,
    "matchedAuthor" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetailerMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceObservation" (
    "id" TEXT NOT NULL,
    "retailerMatchId" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RetailerMatch_tbrItemId_retailer_key" ON "RetailerMatch"("tbrItemId", "retailer");

-- AddForeignKey
ALTER TABLE "RetailerMatch" ADD CONSTRAINT "RetailerMatch_tbrItemId_fkey" FOREIGN KEY ("tbrItemId") REFERENCES "GoodreadsTbrItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceObservation" ADD CONSTRAINT "PriceObservation_retailerMatchId_fkey" FOREIGN KEY ("retailerMatchId") REFERENCES "RetailerMatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
