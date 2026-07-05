import { prisma } from "@/lib/prisma";
import { parseCopyFields } from "@/lib/books";

export interface CopyFormState {
  error?: string;
}

interface CopyFieldsInput {
  format: string;
  publisher: string;
  publishYear: string;
  specialNotes: string;
}

export async function addCopyData(
  bookId: string,
  input: CopyFieldsInput,
): Promise<{ copyId: string } | { error: string }> {
  const parsed = parseCopyFields(input);
  if ("error" in parsed) {
    return parsed;
  }

  const copy = await prisma.physicalCopy.create({
    data: { bookId, ...parsed },
  });

  return { copyId: copy.id };
}

export async function updateCopyData(
  copyId: string,
  input: CopyFieldsInput,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseCopyFields(input);
  if ("error" in parsed) {
    return parsed;
  }

  await prisma.physicalCopy.update({
    where: { id: copyId },
    data: parsed,
  });

  return { ok: true };
}

export async function deleteCopyData(
  copyId: string,
): Promise<{ bookId: string; bookDeleted: boolean }> {
  const copy = await prisma.physicalCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { bookId: true },
  });

  await prisma.physicalCopy.delete({ where: { id: copyId } });

  const remaining = await prisma.physicalCopy.count({ where: { bookId: copy.bookId } });

  if (remaining === 0) {
    await prisma.book.delete({ where: { id: copy.bookId } });
    return { bookId: copy.bookId, bookDeleted: true };
  }

  return { bookId: copy.bookId, bookDeleted: false };
}
