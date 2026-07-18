import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { updateEbookCopyCoverData } from "@/lib/ebookCopies";
import { saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const savedPaths: string[] = [];

afterEach(async () => {
  for (const p of savedPaths) {
    await rm(path.join(uploadsDir, p), { force: true });
  }
  savedPaths.length = 0;
  await prisma.ebookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test Ebook Copy Cover" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Ebook Copy Cover" } } });
});

const ONE_PX_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("updateEbookCopyCoverData", () => {
  it("sets a cover on an ebook copy that has none yet", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Ebook Copy Cover Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-ebook-cover-1" } },
      },
      include: { ebookCopies: true },
    });
    const copy = book.ebookCopies[0];

    const result = await updateEbookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.ebookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
    savedPaths.push(updated.coverImagePath as string);
  });

  it("replaces an existing cover and deletes the old file", async () => {
    const oldPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    const book = await prisma.book.create({
      data: {
        title: "Test Ebook Copy Cover Replace Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-ebook-cover-2", coverImagePath: oldPath } },
      },
      include: { ebookCopies: true },
    });
    const copy = book.ebookCopies[0];

    const result = await updateEbookCopyCoverData(copy.id, {
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.ebookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(updated.coverImagePath).not.toBe(oldPath);
    savedPaths.push(updated.coverImagePath as string);
    await expect(readFile(path.join(uploadsDir, oldPath))).rejects.toThrow();
  });

  it("returns an error and leaves the copy unchanged for an invalid cover", async () => {
    const book = await prisma.book.create({
      data: {
        title: "Test Ebook Copy Cover Invalid Book",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "test-ebook-cover-3" } },
      },
      include: { ebookCopies: true },
    });
    const copy = book.ebookCopies[0];

    const result = await updateEbookCopyCoverData(copy.id, {
      selectedCoverDataUrl: "not-a-data-url",
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ error: "Invalid cover image" });
    const unchanged = await prisma.ebookCopy.findUniqueOrThrow({ where: { id: copy.id } });
    expect(unchanged.coverImagePath).toBeNull();
  });
});
