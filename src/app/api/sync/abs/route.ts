import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { syncAbsCache } from "@/lib/absSync";
import { TBR_GAP_CACHE_TAG } from "@/lib/tbrGap";

export async function POST() {
  const absUrl = process.env.ABS_URL;
  const absToken = process.env.ABS_TOKEN;

  if (!absUrl || !absToken) {
    return NextResponse.json(
      { success: false, error: "Server misconfigured: ABS_URL/ABS_TOKEN not set" },
      { status: 500 },
    );
  }

  try {
    const result = await syncAbsCache(absUrl, absToken);
    // Owned-titles data changed; bust the cached TBR gap computation
    // immediately so the next /tbr load reflects the new sync results
    // instead of serving stale data for up to the 30-minute safety window.
    revalidateTag(TBR_GAP_CACHE_TAG, { expire: 0 });
    return NextResponse.json({ success: true, synced: result.synced });
  } catch (error) {
    console.error("ABS sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ABS sync failed" },
      { status: 502 },
    );
  }
}
