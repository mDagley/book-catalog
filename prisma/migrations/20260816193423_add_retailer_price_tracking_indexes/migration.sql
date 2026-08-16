-- CreateIndex
CREATE INDEX "PriceObservation_retailerMatchId_observedAt_idx" ON "PriceObservation"("retailerMatchId", "observedAt");

-- CreateIndex
CREATE INDEX "RetailerMatch_confirmed_idx" ON "RetailerMatch"("confirmed");
