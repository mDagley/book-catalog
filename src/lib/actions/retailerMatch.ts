"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export async function confirmRetailerMatch(matchId: string): Promise<void> {
  await prisma.retailerMatch.update({ where: { id: matchId }, data: { confirmed: true } });
  revalidatePath("/tbr");
}

// Deletes the match outright, rather than marking it rejected -- the unique
// constraint on (tbrItemId, retailer) means findRetailerMatches will attempt
// this pair again on its next daily run once the row is gone.
export async function rejectRetailerMatch(matchId: string): Promise<void> {
  await prisma.retailerMatch.delete({ where: { id: matchId } });
  revalidatePath("/tbr");
}
