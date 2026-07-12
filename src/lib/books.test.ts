import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createBookWithCopyData, updateBookData } from "@/lib/books";

const createdBookIds: string[] = [];

afterEach(async () => {
  for (const id of createdBookIds) {
    // PhysicalCopy.bookId is ON DELETE RESTRICT, so copies must be removed
    // before the parent book can be deleted.
    await prisma.physicalCopy.deleteMany({ where: { bookId: id } });
    await prisma.book.deleteMany({ where: { id } });
  }
  createdBookIds.length = 0;
});

describe("createBookWithCopyData", () => {
  it("creates a book with an initial copy", async () => {
    const result = await createBookWithCopyData({
      title: "Test Book",
      author: "Test Author",
      isbn: "1234567890",
      format: "HARDCOVER",
      publisher: "Test Publisher",
      publishYear: "2020",
      specialNotes: "Signed",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    createdBookIds.push(result.bookId);

    const book = await prisma.book.findUnique({
      where: { id: result.bookId },
      include: { copies: true },
    });
    expect(book?.title).toBe("Test Book");
    expect(book?.author).toBe("Test Author");
    expect(book?.isbn).toBe("1234567890");
    expect(book?.copies).toHaveLength(1);
    expect(book?.copies[0].format).toBe("HARDCOVER");
    expect(book?.copies[0].publisher).toBe("Test Publisher");
    expect(book?.copies[0].publishYear).toBe(2020);
    expect(book?.copies[0].specialNotes).toBe("Signed");
  });

  it("treats empty optional fields as null, not empty strings", async () => {
    const result = await createBookWithCopyData({
      title: "Minimal Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    createdBookIds.push(result.bookId);

    const book = await prisma.book.findUnique({
      where: { id: result.bookId },
      include: { copies: true },
    });
    expect(book?.author).toBeNull();
    expect(book?.isbn).toBeNull();
    expect(book?.copies[0].publisher).toBeNull();
    expect(book?.copies[0].publishYear).toBeNull();
    expect(book?.copies[0].specialNotes).toBeNull();
  });

  it("returns an error when title is empty or whitespace-only", async () => {
    const result = await createBookWithCopyData({
      title: "   ",
      author: "",
      isbn: "",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "Title is required" });
  });

  it("returns an error when format is invalid", async () => {
    const result = await createBookWithCopyData({
      title: "Test Book",
      author: "",
      isbn: "",
      format: "INVALID_FORMAT",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "A valid format is required" });
  });

  it("returns an error when publish year is not a number", async () => {
    const result = await createBookWithCopyData({
      title: "Test Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "not-a-year",
      specialNotes: "",
    });
    expect(result).toEqual({ error: "Publish year must be a number" });
  });

  it("accepts an optional coverImagePath and stores it on the copy", async () => {
    const result = await createBookWithCopyData({
      title: "Cover Test Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      coverImagePath: "abc123.png",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    createdBookIds.push(result.bookId);

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: result.bookId },
      include: { copies: true },
    });
    expect(book.copies[0].coverImagePath).toBe("abc123.png");
  });

  it("attaches a new copy to an existing book with the same ISBN instead of creating a duplicate", async () => {
    const first = await createBookWithCopyData({
      title: "Dedup Test Book",
      author: "Original Author",
      isbn: "9999999999999",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    createdBookIds.push(first.bookId);

    const second = await createBookWithCopyData({
      title: "Dedup Test Book (Reissue Title Ignored)",
      author: "",
      isbn: "9999999999999",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in second).toBe(false);
    if ("error" in second) return;

    expect(second.bookId).toBe(first.bookId);

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: first.bookId },
      include: { copies: true },
    });
    expect(book.copies).toHaveLength(2);
    expect(book.title).toBe("Dedup Test Book"); // original title preserved, not overwritten
  });

  it("creates a new book when the ISBN doesn't match any existing book", async () => {
    const first = await createBookWithCopyData({
      title: "No Match Book One",
      author: "",
      isbn: "1111111111111",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    createdBookIds.push(first.bookId);

    const second = await createBookWithCopyData({
      title: "No Match Book Two",
      author: "",
      isbn: "2222222222222",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in second).toBe(false);
    if ("error" in second) return;
    createdBookIds.push(second.bookId);

    expect(second.bookId).not.toBe(first.bookId);
  });
});

describe("updateBookData", () => {
  async function createTestBook() {
    const created = await createBookWithCopyData({
      title: "Original Title",
      author: "",
      isbn: "",
      format: "OTHER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    if ("error" in created) throw new Error("test setup failed");
    createdBookIds.push(created.bookId);
    return created.bookId;
  }

  it("updates a book's title/author/isbn", async () => {
    const bookId = await createTestBook();

    const result = await updateBookData(bookId, {
      title: "Updated Title",
      author: "New Author",
      isbn: "9999999999",
    });

    expect(result).toEqual({ ok: true });
    const book = await prisma.book.findUnique({ where: { id: bookId } });
    expect(book?.title).toBe("Updated Title");
    expect(book?.author).toBe("New Author");
    expect(book?.isbn).toBe("9999999999");
  });

  it("returns an error when title is empty", async () => {
    const bookId = await createTestBook();
    const result = await updateBookData(bookId, { title: "", author: "", isbn: "" });
    expect(result).toEqual({ error: "Title is required" });
  });
});
