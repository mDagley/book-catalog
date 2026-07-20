"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { addCopyData, updateCopyData, deleteCopyData, type CopyFormState } from "@/lib/copies";

export async function addCopy(
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await addCopyData(bookId, {
    format: (formData.get("format") as string) ?? "",
    publisher: (formData.get("publisher") as string) ?? "",
    publishYear: (formData.get("publishYear") as string) ?? "",
    specialNotes: (formData.get("specialNotes") as string) ?? "",
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}`);
}

export async function updateCopy(
  copyId: string,
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await updateCopyData(copyId, {
    format: (formData.get("format") as string) ?? "",
    publisher: (formData.get("publisher") as string) ?? "",
    publishYear: (formData.get("publishYear") as string) ?? "",
    specialNotes: (formData.get("specialNotes") as string) ?? "",
    selectedCoverDataUrl: formData.get("selectedCoverDataUrl")?.toString() ?? "",
    selectedCoverSource: formData.get("selectedCoverSource")?.toString(),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}/edit`);
}

export async function deleteCopy(copyId: string, _formData: FormData): Promise<void> {
  let bookId: string;
  let bookDeleted: boolean;

  try {
    const result = await deleteCopyData(copyId);
    bookId = result.bookId;
    bookDeleted = result.bookDeleted;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      // The copy was already deleted (e.g. a stale link from another tab, or
      // a double-click) — Prisma's findUniqueOrThrow throws in this case.
      // Treat it as a harmless no-op rather than crashing with a raw 500.
      revalidatePath("/books");
      redirect("/books");
    }
    throw error;
  }

  if (bookDeleted) {
    revalidatePath("/books");
    redirect("/books");
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
}
