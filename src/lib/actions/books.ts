"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createBookWithCopyData,
  saveCoverFromUrl,
  updateBookData,
  type BookFormState,
} from "@/lib/books";
import { deleteCoverImage, saveCoverImage } from "@/lib/coverStorage";

export async function createBookWithCopy(
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const result = await createBookWithCopyData({
    title: (formData.get("title") as string) ?? "",
    author: (formData.get("author") as string) ?? "",
    isbn: (formData.get("isbn") as string) ?? "",
    format: (formData.get("format") as string) ?? "",
    publisher: (formData.get("publisher") as string) ?? "",
    publishYear: (formData.get("publishYear") as string) ?? "",
    specialNotes: (formData.get("specialNotes") as string) ?? "",
    coverImagePath: formData.get("coverImagePath")?.toString(),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath("/books");
  redirect(`/books/${result.bookId}`);
}

export async function createBookFromScan(
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const selectedCoverDataUrl = formData.get("selectedCoverDataUrl")?.toString() ?? "";
  const selectedCoverSource = formData.get("selectedCoverSource")?.toString();

  let coverImagePath: string | undefined;
  if (selectedCoverDataUrl) {
    if (selectedCoverSource === "url") {
      const coverResult = await saveCoverFromUrl(selectedCoverDataUrl);
      if ("error" in coverResult) {
        return { error: coverResult.error };
      }
      coverImagePath = coverResult.coverImagePath;
    } else if (selectedCoverSource === "dataUrl") {
      try {
        coverImagePath = await saveCoverImage(selectedCoverDataUrl);
      } catch {
        return { error: "Invalid cover image" };
      }
    } else {
      return { error: "Invalid cover selection" };
    }
  }

  const result = await createBookWithCopyData({
    title: formData.get("title")?.toString() ?? "",
    author: formData.get("author")?.toString() ?? "",
    isbn: formData.get("isbn")?.toString() ?? "",
    format: formData.get("format")?.toString() ?? "",
    publisher: formData.get("publisher")?.toString() ?? "",
    publishYear: formData.get("publishYear")?.toString() ?? "",
    specialNotes: formData.get("specialNotes")?.toString() ?? "",
    coverImagePath,
  });

  if ("error" in result) {
    if (coverImagePath) {
      await deleteCoverImage(coverImagePath);
    }
    return { error: result.error };
  }

  const scanAnother = formData.get("scanAnother") === "true";
  revalidatePath("/books");
  redirect(scanAnother ? "/books/scan" : `/books/${result.bookId}`);
}

export async function updateBook(
  bookId: string,
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const result = await updateBookData(bookId, {
    title: (formData.get("title") as string) ?? "",
    author: (formData.get("author") as string) ?? "",
    isbn: (formData.get("isbn") as string) ?? "",
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}`);
}
