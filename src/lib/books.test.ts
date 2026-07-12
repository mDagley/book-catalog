import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createBookWithCopyData, updateBookData, saveCoverFromUrl } from "@/lib/books";

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

  it("rejects a coverImagePath that doesn't match the safe filename format", async () => {
    const result = await createBookWithCopyData({
      title: "Path Traversal Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      coverImagePath: "../../../etc/passwd",
    });

    expect(result).toEqual({ error: "Invalid cover image reference" });
  });

  it("normalizes an empty-string coverImagePath to null", async () => {
    const result = await createBookWithCopyData({
      title: "Empty Cover Path Book",
      author: "",
      isbn: "",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
      coverImagePath: "",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    createdBookIds.push(result.bookId);

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: result.bookId },
      include: { copies: true },
    });
    expect(book.copies[0].coverImagePath).toBeNull();
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

  it("matches the oldest existing book deterministically when multiple books share an ISBN", async () => {
    // Book.isbn has no unique constraint, so simulate a pre-existing duplicate
    // by creating two books with the same ISBN directly, bypassing the dedup
    // path (which would otherwise prevent this from ever happening via the
    // public API).
    const older = await prisma.book.create({ data: { title: "Older Duplicate", isbn: "5555555555555" } });
    createdBookIds.push(older.id);
    const newer = await prisma.book.create({ data: { title: "Newer Duplicate", isbn: "5555555555555" } });
    createdBookIds.push(newer.id);

    const result = await createBookWithCopyData({
      title: "",
      author: "",
      isbn: "5555555555555",
      format: "PAPERBACK",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.bookId).toBe(older.id);
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

describe("saveCoverFromUrl", () => {
  const originalFetch = global.fetch;
  const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";
  const savedPaths: string[] = [];

  afterEach(async () => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const p of savedPaths) {
      await rm(path.join(uploadsDir, p), { force: true });
    }
    savedPaths.length = 0;
  });

  it("saves the image when fetched from the Open Library covers host", async () => {
    // 1x1 transparent PNG
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Buffer.from(pngBase64, "base64"),
    } as unknown as Response);

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath);
    expect(result.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
  });

  it("rejects a URL whose host isn't the Open Library covers CDN, without fetching", async () => {
    global.fetch = vi.fn();

    const result = await saveCoverFromUrl("https://evil.example.com/steal-metadata.jpg");

    expect(result).toEqual({ error: "Unsupported cover image host" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns a clear error instead of throwing when the fetch itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect("error" in result).toBe(true);
  });

  it("returns a clear error when the response is not ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/99999-M.jpg");

    expect("error" in result).toBe(true);
  });

  it("does not follow redirects, and rejects a redirect response instead of fetching it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      type: "opaqueredirect",
    } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Failed to fetch cover image" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://covers.openlibrary.org/b/id/12345-M.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("strips content-type parameters before matching against supported image types", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: "basic",
      headers: new Headers({ "content-type": "image/png; charset=binary" }),
      arrayBuffer: async () => Buffer.from(pngBase64, "base64"),
    } as unknown as Response);

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath);
    expect(result.coverImagePath).toMatch(/^[a-f0-9-]+\.png$/);
  });
});
