-- DropForeignKey
ALTER TABLE "PriceObservation" DROP CONSTRAINT "PriceObservation_retailerMatchId_fkey";

-- DropForeignKey
ALTER TABLE "RetailerMatch" DROP CONSTRAINT "RetailerMatch_tbrItemId_fkey";

-- AddForeignKey
ALTER TABLE "RetailerMatch" ADD CONSTRAINT "RetailerMatch_tbrItemId_fkey" FOREIGN KEY ("tbrItemId") REFERENCES "GoodreadsTbrItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceObservation" ADD CONSTRAINT "PriceObservation_retailerMatchId_fkey" FOREIGN KEY ("retailerMatchId") REFERENCES "RetailerMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
