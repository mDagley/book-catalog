import { prisma } from "@/lib/prisma";

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

  const copyData = { ...parsedCopy, coverImagePath: input.coverImagePath ?? null };

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
