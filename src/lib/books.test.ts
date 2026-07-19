import { describe, it, expect, afterEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { createBookWithCopyData, updateBookData, saveCoverFromUrl } from "@/lib/books";

const createdBookIds: string[] = [];

afterEach(async () => {
  for (const id of createdBookIds) {
    // PhysicalCopy/EbookCopy/AudiobookCopy.bookId are all ON DELETE
    // RESTRICT, so copies must be removed before the parent book can be
    // deleted.
    await prisma.physicalCopy.deleteMany({ where: { bookId: id } });
    await prisma.ebookCopy.deleteMany({ where: { bookId: id } });
    await prisma.audiobookCopy.deleteMany({ where: { bookId: id } });
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

  it("dedups a hyphenated ISBN against a bare-digit ISBN for the same book", async () => {
    const first = await createBookWithCopyData({
      title: "Normalization Test Book",
      author: "Original Author",
      isbn: "978-0-7653-2635-5",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });
    expect("error" in first).toBe(false);
    if ("error" in first) return;
    createdBookIds.push(first.bookId);

    const firstBook = await prisma.book.findUniqueOrThrow({ where: { id: first.bookId } });
    expect(firstBook.isbn).toBe("9780765326355");

    const second = await createBookWithCopyData({
      title: "Normalization Test Book (Scanned Copy)",
      author: "",
      isbn: "9780765326355",
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
  });

  it("attaches a new copy to an existing book with a matching title but a different/absent ISBN, instead of creating a duplicate", async () => {
    // Reproduces the reported bug: an ebook/audiobook-only Book (no physical
    // copies, no isbn set -- e.g. from an ABS sync) already exists for this
    // title. Scanning a physical edition almost always carries a DIFFERENT
    // ISBN than the ebook's, so the ISBN check alone can never find this
    // existing row -- a title fuzzy-match fallback is required.
    const existing = await prisma.book.create({
      data: {
        title: "Test Books Existing Ebook Only Title",
        hasEbook: true,
        ebookCopies: { create: { absItemId: "existing-ebook-item" } },
      },
    });
    createdBookIds.push(existing.id);

    const result = await createBookWithCopyData({
      title: "Test Books Existing Ebook Only Title",
      author: "",
      isbn: "9780765326355",
      format: "HARDCOVER",
      publisher: "",
      publishYear: "",
      specialNotes: "",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // Registered for cleanup regardless of outcome: if the fix regresses and
    // this creates a new (duplicate) row instead of reusing `existing.id`,
    // that row must still be cleaned up by afterEach rather than leaking.
    createdBookIds.push(result.bookId);
    expect(result.bookId).toBe(existing.id);

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: existing.id },
      include: { copies: true },
    });
    expect(book.copies).toHaveLength(1);
    expect(book.copies[0].format).toBe("HARDCOVER");
    expect(book.hasEbook).toBe(true);
    expect(book.title).toBe("Test Books Existing Ebook Only Title"); // not overwritten by the scan's input
    expect(book.isbn).toBeNull(); // not backfilled from the scan -- matched by title, not by ISBN
  });

  it("does not fuzzy-match a purely physical existing book, even with an identical title", async () => {
    // The fuzzy-match fallback exists specifically to reattach a scanned
    // physical copy to an already-owned ebook/audiobook entry -- it must not
    // also merge two unrelated physical-only books together just because
    // their titles happen to match (e.g. two different real books that
    // happen to share a common title).
    const existing = await prisma.book.create({
      data: {
        title: "Test Books Purely Physical Existing Book",
        copies: { create: { format: "HARDCOVER" } },
      },
    });
    createdBookIds.push(existing.id);

    const result = await createBookWithCopyData({
      title: "Test Books Purely Physical Existing Book",
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
    expect(result.bookId).not.toBe(existing.id);
  });

  it("creates a new book when no existing title is a close enough fuzzy match", async () => {
    const existing = await prisma.book.create({
      data: { title: "Completely Unrelated Existing Book" },
    });
    createdBookIds.push(existing.id);

    const result = await createBookWithCopyData({
      title: "Totally Different New Book Title Zzz",
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
    expect(result.bookId).not.toBe(existing.id);
  });

  it("creates a new book when the ISBN doesn't match any existing book", async () => {
    // Deliberately dissimilar titles (unlike the fuzzy-match tests above,
    // which need close titles): "No Match Book One"/"Two" would themselves
    // fuzzy-match each other above threshold, which would defeat the point
    // of this test.
    const first = await createBookWithCopyData({
      title: "Distinctly Different First Book",
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
      title: "Wholly Unrelated Second Volume",
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

  it("returns reason: 'unsupported_format' when the fetched cover's content-type isn't saveable", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/gif" }),
      arrayBuffer: async () => Buffer.from("not-really-a-gif"),
    } as unknown as Response);

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({
      error: "Unsupported cover image format",
      reason: "unsupported_format",
    });
  });

  it("does not set reason on a plain fetch failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Failed to fetch cover image" });
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

  it("rejects a redirect response with no Location header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      type: "opaqueredirect",
      headers: new Headers(),
    } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Failed to fetch cover image" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://covers.openlibrary.org/b/id/12345-M.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("does not treat a 304 Not Modified as a redirect to follow, even with a Location header present", async () => {
    // A real Location header on a 304 is unusual, but proves the point: the
    // old blanket "300 <= status < 400" check would have matched 304 as a
    // redirect and issued a second fetch to this URL. The fix restricts the
    // check to actual redirect status codes, so this must resolve as a
    // plain non-ok response after exactly one fetch call.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 304,
      type: "default",
      headers: new Headers({ location: "https://covers.openlibrary.org/b/id/99999-M.jpg" }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Failed to fetch cover image" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a single redirect to another allowed URL and saves the image", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        type: "basic",
        headers: new Headers({ location: "https://covers.openlibrary.org/b/id/99999-M.jpg" }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        type: "basic",
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Buffer.from(pngBase64, "base64"),
      } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://covers.openlibrary.org/b/id/99999-M.jpg",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("follows a two-hop redirect from Open Library's covers CDN through archive.org's storage and saves the image", async () => {
    // Confirmed against the real API: covers.openlibrary.org 302-redirects
    // some (not all) covers to archive.org's bulk cover-zip storage, which
    // itself 302-redirects again to a specific numbered storage shard
    // (ia600703.us.archive.org -- the shard varies by item/availability,
    // hence the endsWith(".archive.org") check rather than a fixed list).
    // Both hops are real, legitimate Open Library redirect targets, not an
    // attacker trying to redirect off the allowlist.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        type: "basic",
        headers: new Headers({
          location: "https://archive.org/download/m_covers_0008/m_covers_0008_23.zip/0008231856-M.jpg",
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        type: "basic",
        headers: new Headers({
          location:
            "https://ia600703.us.archive.org/view_archive.php?archive=/4/items/m_covers_0008/m_covers_0008_23.zip&file=0008231856-M.jpg",
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        type: "basic",
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Buffer.from(pngBase64, "base64"),
      } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/8231856-M.jpg");

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    savedPaths.push(result.coverImagePath);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a redirect that points off the allowlist, without fetching it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      type: "basic",
      headers: new Headers({ location: "https://evil.example.com/steal-metadata.jpg" }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Unsupported cover image host" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect to a lookalike host that merely ends with 'archive.org' as a suffix of an unrelated domain", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      type: "basic",
      headers: new Headers({ location: "https://evil-archive.org.attacker.com/steal.jpg" }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Unsupported cover image host" });
  });

  it("rejects a redirect chain that exceeds the hop limit rather than following it unbounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      type: "basic",
      headers: new Headers({ location: "https://covers.openlibrary.org/b/id/99999-M.jpg" }),
    } as unknown as Response);
    global.fetch = fetchMock;

    const result = await saveCoverFromUrl("https://covers.openlibrary.org/b/id/12345-M.jpg");

    expect(result).toEqual({ error: "Failed to fetch cover image" });
    // MAX_COVER_FETCH_REDIRECTS (3) allowed hops + the initial request = 4
    // fetch calls before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
