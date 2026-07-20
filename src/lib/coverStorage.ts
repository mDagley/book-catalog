import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Thrown specifically for the "image format we don't save" case, distinct
// from the generic Error thrown for a malformed data URL or an oversized
// payload -- callers (saveCoverFromUrl, fetchAbsCoverAndSave) catch this
// specifically so a cover that WAS found, just in an unsaveable format, can
// be recorded differently from a genuine "no cover exists" outcome. See
// docs/superpowers/specs/2026-07-19-cover-fetch-robustness-design.md.
export class UnsupportedCoverFormatError extends Error {
  constructor(mimeType: string) {
    super(`Unsupported image type: ${mimeType}`);
    this.name = "UnsupportedCoverFormatError";
  }
}

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/;

// Generous headroom above what a downscaled 800px JPEG (client-captured cover
// photo) or a typical Open Library cover would ever produce, while still
// blocking pathological inputs.
const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// Valid stored cover filenames are always a UUID plus a known extension (see
// saveCoverImage below). Shared with the /api/covers/[filename] route (which
// uses it to reject path traversal before reading from disk) and with
// createBookWithCopyData (which uses it to reject malformed values before
// they're ever persisted).
export const SAFE_COVER_FILENAME = /^[a-f0-9-]+\.(png|jpg|webp)$/;

export async function saveCoverImage(dataUrl: string): Promise<string> {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid data URL");
  }

  const [, mimeType, base64Data] = match;
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new UnsupportedCoverFormatError(mimeType);
  }

  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length > MAX_COVER_IMAGE_BYTES) {
    throw new Error("Cover image is too large");
  }

  await mkdir(UPLOADS_DIR, { recursive: true });

  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(UPLOADS_DIR, filename), buffer);

  return filename;
}

export async function deleteCoverImage(filename: string): Promise<void> {
  // Best-effort cleanup only: an invalid/unsafe filename (e.g. containing
  // path traversal) is silently ignored, and any error thrown by `rm`
  // (permission issues, unexpected file types, etc. — { force: true } only
  // suppresses a missing-file/ENOENT error) is swallowed, so this function
  // never throws.
  if (!SAFE_COVER_FILENAME.test(filename)) {
    return;
  }
  try {
    await rm(path.join(UPLOADS_DIR, filename), { force: true });
  } catch {
    // Ignore — cleanup is best-effort only.
  }
}
