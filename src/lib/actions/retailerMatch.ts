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

// Deletes the match outright, rather than marking it rejected -- the unique
// constraint on (tbrItemId, retailer) means findRetailerMatches will attempt
// this pair again on its next daily run once the row is gone.
export async function rejectRetailerMatch(matchId: string): Promise<void> {
  try {
    await prisma.retailerMatch.delete({ where: { id: matchId } });
  } catch (err) {
    if (!isRecordNotFound(err)) throw err;
  }
  revalidatePath("/tbr");
}
