import { NextResponse } from "next/server";
import { syncGoodreadsTbr } from "@/lib/goodreadsSync";
import { syncOwnedPhysicalBooks } from "@/lib/ownedPhysicalSync";

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

  try {
    const shelfName = process.env.GOODREADS_OWNED_PHYSICAL_SHELF || undefined;
    const result = await syncOwnedPhysicalBooks(userId, shelfName);
    synced += result.synced;
  } catch (error) {
    console.error("Owned-physical sync failed:", error);
    errors.push(error instanceof Error ? error.message : "Owned-physical sync failed");
  }

  if (errors.length > 0) {
    return NextResponse.json({ success: false, error: errors.join("; ") }, { status: 502 });
  }
  return NextResponse.json({ success: true, synced });
}
