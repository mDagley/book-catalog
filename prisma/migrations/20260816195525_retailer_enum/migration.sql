/*
  Warnings:

  - Changed the type of `retailer` on the `RetailerMatch` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "Retailer" AS ENUM ('librofm', 'googleplay');

-- AlterTable
ALTER TABLE "RetailerMatch" DROP COLUMN "retailer",
ADD COLUMN     "retailer" "Retailer" NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "RetailerMatch_tbrItemId_retailer_key" ON "RetailerMatch"("tbrItemId", "retailer");
