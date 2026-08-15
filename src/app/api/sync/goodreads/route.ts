import { NextResponse } from "next/server";
import { syncGoodreadsTbr } from "@/lib/goodreadsSync";
import { syncOwnedPhysicalBooks } from "@/lib/ownedPhysicalSync";
import { refreshDuplicateGroupsCache } from "@/lib/duplicates";

export async function POST() {
  const userId = process.env.GOODREADS_USER_ID;

  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Server misconfigured: GOODREADS_USER_ID not set" },
      { status: 500 },
    );
  }

  let synced = 0;
  const errors: string[] = [];

  try {
    const result = await syncGoodreadsTbr(userId);
    synced += result.synced;
  } catch (error) {
    console.error("Goodreads sync failed:", error);
    errors.push(error instanceof Error ? error.message : "Goodreads sync failed");
  }

  let ownedPhysicalSynced = false;
  try {
    const shelfName = process.env.GOODREADS_OWNED_PHYSICAL_SHELF || undefined;
    const result = await syncOwnedPhysicalBooks(userId, shelfName);
    synced += result.synced;
    ownedPhysicalSynced = true;
  } catch (error) {
    console.error("Owned-physical sync failed:", error);
    errors.push(error instanceof Error ? error.message : "Owned-physical sync failed");
  }

  // Outside the sync's own try/catch (and only attempted when that sync
  // actually succeeded) so a refresh failure here is reported as its own
  // thing, never misattributed as "Owned-physical sync failed" for a sync
  // that in fact completed fine.
  if (ownedPhysicalSynced) {
    try {
      // New physical-copy books can duplicate an already-owned ebook/
      // audiobook row -- the persisted duplicate cache needs a recompute
      // after this sync, same as the ABS sync route.
      await refreshDuplicateGroupsCache();
    } catch (error) {
      console.error("Duplicate-groups cache refresh failed:", error);
      errors.push(
        error instanceof Error ? error.message : "Duplicate-groups cache refresh failed",
      );
    }
  }

  if (errors.length > 0) {
    return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 502 });
  }
  return NextResponse.json({ success: true, synced });
}
