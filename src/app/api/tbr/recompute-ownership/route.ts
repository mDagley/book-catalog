import { NextResponse } from "next/server";
import { recomputeAllTbrOwnership } from "@/lib/tbrGap";

// Manual "Recompute ownership" trigger for /tbr. The `owned` flag is
// maintained incrementally by hooks at every Book create/delete/retitle site,
// so this should never be NEEDED in normal operation -- it exists for the two
// cases those hooks can't cover: the initial post-migration backfill (every
// pre-existing row defaults to owned:false), and repairing drift if a row is
// ever changed by something outside those paths (a manual DB edit, a restored
// backup, a future code path that forgets to call the hooks).
//
// Runs the full TBR-items x owned-books fuzzy cross-product, so it is
// deliberately slow (tens of seconds on a large library) and deliberately
// user-triggered rather than automatic.
export async function POST() {
  try {
    const result = await recomputeAllTbrOwnership();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("TBR ownership recompute failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Ownership recompute failed",
      },
      { status: 500 },
    );
  }
}
