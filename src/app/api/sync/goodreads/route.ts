import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { syncGoodreadsTbr } from "@/lib/goodreadsSync";
import { TBR_GAP_CACHE_TAG } from "@/lib/tbrGap";

export async function POST() {
  const userId = process.env.GOODREADS_USER_ID;

  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Server misconfigured: GOODREADS_USER_ID not set" },
      { status: 500 },
    );
  }

  try {
    const result = await syncGoodreadsTbr(userId);
    // TBR list changed; bust the cached TBR gap computation immediately so
    // the next /tbr load reflects the new sync results instead of serving
    // stale data for up to the 30-minute safety window.
    revalidateTag(TBR_GAP_CACHE_TAG, { expire: 0 });
    return NextResponse.json({ success: true, synced: result.synced });
  } catch (error) {
    console.error("Goodreads sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Goodreads sync failed" },
      { status: 502 },
    );
  }
}
