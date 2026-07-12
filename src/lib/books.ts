import { prisma } from "@/lib/prisma";
import { saveCoverImage } from "@/lib/coverStorage";

export interface BookFormState {
  error?: string;
}

export const VALID_FORMATS = ["HARDCOVER", "PAPERBACK", "MASS_MARKET", "OTHER"] as const;
export type BookFormat = (typeof VALID_FORMATS)[number];

interface CopyFieldsInput {
  format: string;
  publisher: string;
  publishYear: string;
  specialNotes: string;
}

interface ParsedCopyFields {
  format: BookFormat;
  publisher: string | null;
  publishYear: number | null;
  specialNotes: string | null;
}

export function parseCopyFields(
  input: CopyFieldsInput,
): ParsedCopyFields | { error: string } {
  if (!VALID_FORMATS.includes(input.format as BookFormat)) {
    return { error: "A valid format is required" };
  }

  let publishYear: number | null = null;
  if (input.publishYear.trim()) {
    publishYear = parseInt(input.publishYear, 10);
    if (Number.isNaN(publishYear)) {
      return { error: "Publish year must be a number" };
    }
  }

  return {
    format: input.format as BookFormat,
    publisher: input.publisher.trim() || null,
    publishYear,
    specialNotes: input.specialNotes.trim() || null,
  };
}

export async function createBookWithCopyData(
  input: { title: string; author: string; isbn: string; coverImagePath?: string } & CopyFieldsInput,
): Promise<{ bookId: string } | { error: string }> {
  const title = input.title.trim();
  const isbn = input.isbn.trim() || null;

  const parsedCopy = parseCopyFields(input);
  if ("error" in parsedCopy) {
    return parsedCopy;
  }

  const copyData = { ...parsedCopy, coverImagePath: input.coverImagePath?.trim() || null };

  // Check for an ISBN match before validating the title: a rescan that attaches
  // a new copy to an already-existing book must not require a title, since the
  // existing book's title is authoritative and is never overwritten here.
  if (isbn) {
    const existingBook = await prisma.book.findFirst({ where: { isbn } });
    if (existingBook) {
      await prisma.physicalCopy.create({
        data: { ...copyData, bookId: existingBook.id },
      });
      return { bookId: existingBook.id };
    }
  }

  if (!title) {
    return { error: "Title is required" };
  }

  const book = await prisma.book.create({
    data: {
      title,
      author: input.author.trim() || null,
      isbn,
      copies: { create: copyData },
    },
  });

  return { bookId: book.id };
}

// Open Library is the only source CoverPicker ever populates selectedCoverDataUrl
// from when selectedCoverSource is "url" (see src/lib/isbnLookup.ts). Since the
// form field is just a plain hidden input, a request submitted outside the normal
// UI (devtools/curl) could otherwise point the server at an arbitrary URL, so we
// restrict fetches to Open Library's covers CDN to avoid SSRF.
const ALLOWED_COVER_HOSTS = ["covers.openlibrary.org"];

export async function saveCoverFromUrl(
  url: string,
): Promise<{ coverImagePath: string } | { error: string }> {
  try {
    const { hostname } = new URL(url);
    if (!ALLOWED_COVER_HOSTS.includes(hostname)) {
      return { error: "Unsupported cover image host" };
    }

    const response = await fetch(url);
    if (!response.ok) {
      return { error: "Failed to fetch cover image" };
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "image/jpeg";
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const coverImagePath = await saveCoverImage(`data:${contentType};base64,${base64}`);
    return { coverImagePath };
  } catch {
    return { error: "Failed to fetch cover image" };
  }
}

export async function updateBookData(
  bookId: string,
  input: { title: string; author: string; isbn: string },
): Promise<{ ok: true } | { error: string }> {
  const title = input.title.trim();
  if (!title) {
    return { error: "Title is required" };
  }

  await prisma.book.update({
    where: { id: bookId },
    data: {
      title,
      author: input.author.trim() || null,
      isbn: input.isbn.trim() || null,
    },
  });

  return { ok: true };
}
