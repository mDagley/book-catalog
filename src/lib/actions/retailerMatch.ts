"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

// True when `err` is a Postgres "record not found" error (Prisma P2025) --
// meaning a double-submit or another tab already confirmed/rejected this
// match. Matches the existing precedent in copies.ts's deleteCopyAction:
// treat it as a harmless no-op rather than crashing with a raw 500.
function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

export async function confirmRetailerMatch(matchId: string): Promise<void> {
  try {
    await prisma.retailerMatch.update({ where: { id: matchId }, data: { confirmed: true } });
  } catch (err) {
    if (!isRecordNotFound(err)) throw err;
  }
  revalidatePath("/tbr");
}

// Sets `rejected: true` rather than deleting the row -- findRetailerMatches
// skips any (tbrItemId, retailer) pair that already has a RetailerMatch row,
// so keeping this row around (instead of deleting it) is what permanently
// stops that pair from being re-suggested on a future run. A deleted row
// would look "never matched" and get immediately re-created.
export async function rejectRetailerMatch(matchId: string): Promise<void> {
  try {
    await prisma.retailerMatch.update({ where: { id: matchId }, data: { rejected: true } });
  } catch (err) {
    if (!isRecordNotFound(err)) throw err;
  }
  revalidatePath("/tbr");
}
