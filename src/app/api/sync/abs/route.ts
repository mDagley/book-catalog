import { NextResponse } from "next/server";
import { syncAbsCache } from "@/lib/absSync";

export async function POST() {
  const absUrl = process.env.ABS_URL;
  const absToken = process.env.ABS_TOKEN;

  if (!absUrl || !absToken) {
    return NextResponse.json(
      { error: "Server misconfigured: ABS_URL/ABS_TOKEN not set" },
      { status: 500 },
    );
  }

  try {
    const result = await syncAbsCache(absUrl, absToken);
    return NextResponse.json({ success: true, synced: result.synced });
  } catch (error) {
    console.error("ABS sync failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "ABS sync failed" },
      { status: 502 },
    );
  }
}
