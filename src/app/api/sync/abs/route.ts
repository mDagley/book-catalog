import { NextResponse } from "next/server";
import { syncAbsCache } from "@/lib/absSync";
import { refreshDuplicateGroupsCache } from "@/lib/duplicates";

export async function POST() {
  const absUrl = process.env.ABS_URL;
  const absToken = process.env.ABS_TOKEN;

  if (!absUrl || !absToken) {
    return NextResponse.json(
      { success: false, error: "Server misconfigured: ABS_URL/ABS_TOKEN not set" },
      { status: 500 },
    );
  }

  let syncResult: { synced: number };
  try {
    syncResult = await syncAbsCache(absUrl, absToken);
  } catch (error) {
    console.error("ABS sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ABS sync failed" },
      { status: 502 },
    );
  }

  // Outside syncAbsCache's own try/catch so a refresh failure is reported
  // as its own thing, never misattributed as "ABS sync failed" for a sync
  // that in fact completed fine.
  try {
    // New/changed hasEbook/hasAudiobook flags can create or resolve
    // duplicate groups (the physical-scan-duplicates-a-synced-ebook case
    // this tool exists for), so the persisted cache needs a recompute --
    // see the data freshness model note on refreshDuplicateGroupsCache().
    await refreshDuplicateGroupsCache();
  } catch (error) {
    console.error("Duplicate-groups cache refresh failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Duplicate-groups cache refresh failed",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ success: true, synced: syncResult.synced });
}
