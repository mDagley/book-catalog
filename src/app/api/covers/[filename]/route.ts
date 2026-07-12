import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;

  // Reject any path-traversal attempt or unexpected characters up front —
  // valid filenames are always a UUID plus a known extension (see saveCoverImage).
  if (!/^[a-f0-9-]+\.(png|jpg|webp)$/.test(filename)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = filename.split(".").pop()!;
  const mimeType = EXT_TO_MIME[ext];

  try {
    const data = await readFile(path.join(UPLOADS_DIR, filename));
    return new NextResponse(data, {
      headers: { "Content-Type": mimeType, "Cache-Control": "private, max-age=31536000" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
