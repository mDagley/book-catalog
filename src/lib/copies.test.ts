import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createBookWithCopyData } from "@/lib/books";
import { addCopyData, updateCopyData, deleteCopyData } from "@/lib/copies";
import { deleteCoverImage, saveCoverImage } from "@/lib/coverStorage";

const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
const createdBookIds: string[] = [];
const savedCoverPaths: string[] = [];

afterEach(async () => {
  for (const id of createdBookIds) {
    await prisma.physicalCopy.deleteMany({ where: { bookId: id } });
    await prisma.ebookCopy.deleteMany({ where: { bookId: id } });
    await prisma.audiobookCopy.deleteMany({ where: { bookId: id } });
    await prisma.book.deleteMany({ where: { id } });
  }
  createdBookIds.length = 0;
  for (const p of savedCoverPaths) {
    await deleteCoverImage(p);
  }
  savedCoverPaths.length = 0;
});

async function createTestBook() {
  const created = await createBookWithCopyData({
    title: "Test Book For Copies",
    author: "",
    isbn: "",
    format: "PAPERBACK",
    publisher: "",
    publishYear: "",
    specialNotes: "",
  });
  if ("error" in created) throw new Error("test setup failed");
  createdBookIds.push(created.bookId);
  return created.bookId;
}

describe("addCopyData", () => {
  it("adds a second copy to an existing book", async () => {
    const bookId = await createTestBook();

    const result = await addCopyData(bookId, {
      format: "HARDCOVER",
      publisher: "Second Publisher",
      publishYear: "2015",
      specialNotes: "First edition",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    const copies = await prisma.physicalCopy.findMany({ where: { bookId } });
    expect(copies).toHaveLength(2);
    const newCopy = copies.find((c) => c.id === result.copyId);
    expect(newCopy?.format).toBe("HARDCOVER");
    expect(newCopy?.publisher).toBe("Second Publisher");
    expect(newCopy?.publishYear).toBe(2015);
  });

  it("returns an error when format is invalid", async () => {
    const bookId = await createTestBook();
    const result = await addCopyData(bookId, {
      format: "NOT_A_FORMAT",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "A valid format is required" });
  });
});

describe("updateCopyData", () => {
  it("updates a copy's fields", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await updateCopyData(existingCopy.id, {
      format: "MASS_MARKET",
      publisher: "Updated Publisher",
      publishYear: "1999",
      specialNotes: "Water damaged",
      selectedCoverDataUrl: "",
      selectedCoverSource: undefined,
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.physicalCopy.findUnique({ where: { id: existingCopy.id } });
    expect(updated?.format).toBe("MASS_MARKET");
    expect(updated?.publisher).toBe("Updated Publisher");
    expect(updated?.publishYear).toBe(1999);
    expect(updated?.specialNotes).toBe("Water damaged");
  });

  it("returns an error when format is invalid", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await updateCopyData(existingCopy.id, {
      format: "NOT_A_FORMAT",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      selectedCoverDataUrl: "",
      selectedCoverSource: undefined,
    });
    expect(result).toEqual({ error: "A valid format is required" });
  });

  it("sets a cover on a copy that has none yet", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });
    const ONE_PX_PNG_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    const result = await updateCopyData(existingCopy.id, {
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      selectedCoverDataUrl: ONE_PX_PNG_DATA_URL,
      selectedCoverSource: "dataUrl",
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.physicalCopy.findUniqueOrThrow({ where: { id: existingCopy.id } });
    expect(updated.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
    await deleteCoverImage(updated.coverImagePath as string);
  });

  it("leaves an existing cover untouched when no new cover is selected", async () => {
    const bookId = await createTestBook();
    const [existingCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });
    const ONE_PX_PNG_DATA_URL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const existingCoverPath = await saveCoverImage(ONE_PX_PNG_DATA_URL);
    savedCoverPaths.push(existingCoverPath);
    await prisma.physicalCopy.update({
      where: { id: existingCopy.id },
      data: { coverImagePath: existingCoverPath },
    });

    const result = await updateCopyData(existingCopy.id, {
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      selectedCoverDataUrl: "",
      selectedCoverSource: undefined,
    });

    expect(result).toEqual({ ok: true });
    const updated = await prisma.physicalCopy.findUniqueOrThrow({ where: { id: existingCopy.id } });
    expect(updated.coverImagePath).toBe(existingCoverPath);
    expect(updated.format).toBe("PAPERBACK");

    const stillThere = await readFile(path.join(uploadsDir, existingCoverPath));
    expect(stillThere.length).toBeGreaterThan(0);
  });
});

describe("deleteCopyData", () => {
  it("deletes a copy but keeps the book when other copies remain", async () => {
    const bookId = await createTestBook();
    const addResult = await addCopyData(bookId, {
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    if ("error" in addResult) throw new Error("test setup failed");

    const result = await deleteCopyData(addResult.copyId);

    expect(result).toEqual({ bookId, bookDeleted: false });
    const remainingCopies = await prisma.physicalCopy.findMany({ where: { bookId } });
    expect(remainingCopies).toHaveLength(1);
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    expect(book).not.toBeNull();
  });

  it("deletes the book too when its last copy is removed", async () => {
    const bookId = await createTestBook();
    const [onlyCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await deleteCopyData(onlyCopy.id);

    expect(result).toEqual({ bookId, bookDeleted: true });
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    expect(book).toBeNull();
    // Remove from cleanup list since it's already gone
    const idx = createdBookIds.indexOf(bookId);
    if (idx !== -1) createdBookIds.splice(idx, 1);
  });

  it("keeps the book when its last copy is removed but it still has an ebook link", async () => {
    const bookId = await createTestBook();
    await prisma.book.update({
      where: { id: bookId },
      data: { hasEbook: true, ebookCopies: { create: { absItemId: "test-copies-ebook-link" } } },
    });
    const [onlyCopy] = await prisma.physicalCopy.findMany({ where: { bookId } });

    const result = await deleteCopyData(onlyCopy.id);

    expect(result).toEqual({ bookId, bookDeleted: false });
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    expect(book).not.toBeNull();
    expect(book?.hasEbook).toBe(true);
  });
});
