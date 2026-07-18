import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { updateAudiobookCopyCoverData } from "@/lib/audiobookCopies";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const savedPaths: string[] = [];

afterEach(async () => {
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Audiobook Copy Cover" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Audiobook Copy Cover" } } });
});

const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("updateAudiobookCopyCoverData", () => {
  it("sets a cover on an audiobook copy that has none yet", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Audiobook Copy Cover Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-audiobook-cover-1" } },
      },
      include: { audiobookCopies: true },
    });
    const copy = book.audiobookCopies[0];

    const result = await updateAudiobookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.audiobookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
    savedPaths.push(updated.coverImagePath as string);
  });

  it("replaces an existing cover and deletes the old file", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    const book = await prisma.book.create({
      data: {
        title: "Test Audiobook Copy Cover Replace Book",
        hasAudiobook: true,
        audiobookCopies: {
          create: { absItemId: "test-audiobook-cover-2", coverImagePath: oldPath },
        },
      },
      include: { audiobookCopies: true },
    });
    const copy = book.audiobookCopies[0];

    const result = await updateAudiobookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.audiobookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).not.toBe(oldPath);
    savedPaths.push(updated.coverImagePath as string);
    await expect(readFile(path.join(uploadsDir, oldPath))).rejects.toThrow();
  });

  it("returns an error and leaves the copy unchanged for an invalid cover", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Audiobook Copy Cover Invalid Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-audiobook-cover-3" } },
      },
      include: { audiobookCopies: true },
    });
    const copy = book.audiobookCopies[0];

    const result = await updateAudiobookCopyCoverData(copy.id, {
      selectedCoverDataUrl: "not-a-data-url",
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ error: "Invalid cover image" });
    const unchanged = await prisma.audiobookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(unchanged.coverImagePath).toBeNull();
  });
});
