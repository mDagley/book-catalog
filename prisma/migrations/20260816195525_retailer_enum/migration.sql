-- Manually rewritten from Prisma's auto-generated drop+recreate version --
-- Prisma's migration diff always emits DROP/ADD for a String -> enum type
-- change regardless of whether the target table actually has rows (it's
-- schema-diff-based, not data-aware); the safe, data-preserving equivalent
-- is a plain ALTER COLUMN ... USING cast, which works here because every
-- existing string value ("librofm"/"googleplay") is already a valid enum
-- label. This is not deployed anywhere yet, so no destructive run of the
-- original version has ever gone out.
-- CreateEnum
CREATE TYPE "Retailer" AS ENUM ('librofm', 'googleplay');

-- AlterTable
ALTER TABLE "RetailerMatch" ALTER COLUMN "retailer" TYPE "Retailer" USING ("retailer"::text::"Retailer");
