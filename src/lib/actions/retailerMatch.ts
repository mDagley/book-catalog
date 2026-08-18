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

// Guarded with `rejected: false` in the where clause (via updateMany, not
// update) rather than a plain update -- a rejected row is meant to be
// permanently settled (see rejectRetailerMatch below), so a stale UI or
// tampered request confirming an already-rejected match must not be able
// to resurrect it back into confirmed:true && rejected:true, the same
// invalid state rejectRetailerMatch itself guards against. updateMany
// matching zero rows (already rejected, or already deleted) is a silent
// no-op either way -- no error to catch, unlike update's throw-on-missing.
export async function confirmRetailerMatch(matchId: string): Promise<void> {
  await prisma.retailerMatch.updateMany({
    where: { id: matchId, rejected: false },
    data: { confirmed: true },
  });
  revalidatePath("/tbr");
}

// Sets `rejected: true` rather than deleting the row -- findRetailerMatches
// skips any (tbrItemId, retailer) pair that already has a RetailerMatch row,
// so keeping this row around (instead of deleting it) is what permanently
// stops that pair from being re-suggested on a future run. A deleted row
// would look "never matched" and get immediately re-created.
//
// Also forces confirmed: false. The current UI only ever offers Reject on
// an unconfirmed match, so this never fires against an already-confirmed
// row in practice -- but scrapePrices/getPriceDrops filter on `confirmed`
// alone, not `rejected`, so a row that somehow ended up both confirmed and
// rejected would keep being scraped and could still trigger a drop alert,
// directly contradicting "rejected means settled, stop tracking it."
// Setting confirmed: false here makes that invariant hold unconditionally,
// not just as an accident of which UI states currently expose Reject.
export async function rejectRetailerMatch(matchId: string): Promise<void> {
  try {
    await prisma.retailerMatch.update({
      where: { id: matchId },
      data: { rejected: true, confirmed: false },
    });
  } catch (err) {
    if (!isRecordNotFound(err)) throw err;
  }
  revalidatePath("/tbr");
}
