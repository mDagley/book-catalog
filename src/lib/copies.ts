import { prisma } from "@/lib/prisma";
import { parseCopyFields } from "@/lib/books";
import { resolveCoverUpdate, type CoverSelectionInput } from "@/lib/copyCovers";
import { deleteCoverImage } from "@/lib/coverStorage";
import { recheckOwnedTbrItems } from "@/lib/tbrGap";
import { refreshDuplicateGroupsCache } from "@/lib/duplicates";

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
  input: CopyFieldsInput & CoverSelectionInput,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseCopyFields(input);
  if ("error" in parsed) {
    return parsed;
  }

  const existing = await prisma.physicalCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { coverImagePath: true },
  });

  const coverResult = await resolveCoverUpdate(input, existing.coverImagePath);
  if ("error" in coverResult) {
    return coverResult;
  }

  await prisma.physicalCopy.update({
    where: { id: copyId },
    data: { ...parsed, coverImagePath: coverResult.coverImagePath },
  });

  return { ok: true };
}

export async function deleteCopyData(
  copyId: string,
): Promise<{ bookId: string; bookDeleted: boolean }> {
  const copy = await prisma.physicalCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { bookId: true, coverImagePath: true },
  });

  await prisma.physicalCopy.delete({ where: { id: copyId } });

  if (copy.coverImagePath) {
    await deleteCoverImage(copy.coverImagePath);
  }

  const remaining = await prisma.physicalCopy.count({ where: { bookId: copy.bookId } });

  if (remaining === 0) {
    const book = await prisma.book.findUniqueOrThrow({
      where: { id: copy.bookId },
      select: { hasEbook: true, hasAudiobook: true },
    });
    // A Book with an ebook or audiobook link is still owned even with its
    // last physical copy gone -- only delete when nothing (physical, ebook,
    // or audiobook) backs this row anymore.
    if (!book.hasEbook && !book.hasAudiobook) {
      await prisma.book.delete({ where: { id: copy.bookId } });
      // This title no longer exists -- it may have been the only thing
      // keeping a TBR item marked owned. Runs after the delete commits, and
      // only in this branch: a Book that survives hasn't changed which
      // titles exist, so no recheck is warranted then.
      await recheckOwnedTbrItems();
      // The deleted book may have been a member of a persisted duplicate
      // group (Copilot review finding on PR #44: without this, the group's
      // row would still exist referencing one fewer book than it was
      // computed with, potentially left with only 1 book).
      await refreshDuplicateGroupsCache();
      return { bookId: copy.bookId, bookDeleted: true };
    }
  }

  return { bookId: copy.bookId, bookDeleted: false };
}
