import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/;

export async function saveCoverImage(dataUrl: string): Promise<string> {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new Error("Invalid data URL");
  }

  const [, mimeType, base64Data] = match;
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }

  await mkdir(UPLOADS_DIR, { recursive: true });

  const filename = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(base64Data, "base64");
  await writeFile(path.join(UPLOADS_DIR, filename), buffer);

  return filename;
}
