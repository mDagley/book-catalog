import { NextResponse } from "next/server";
import { syncGoodreadsTbr } from "@/lib/goodreadsSync";

export async function POST() {
  const userId = process.env.GOODREADS_USER_ID;

  if (!userId) {
    return NextResponse.json(
      { error: "Server misconfigured: GOODREADS_USER_ID not set" },
      { status: 500 },
    );
  }

  try {
    const result = await syncGoodreadsTbr(userId);
    return NextResponse.json({ success: true, synced: result.synced });
  } catch (error) {
    console.error("Goodreads sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Goodreads sync failed" },
      { status: 502 },
    );
  }
}
