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

export interface ScanFormState extends BookFormState {
  // Carries back whatever was submitted so the form can restore these as
  // defaultValues on a failed save — a save can fail after the user has
  // filled in fields (title/format/etc.) that aren't tied to lookup data,
  // and re-populating from the last submission (rather than relying on
  // the browser to preserve uncontrolled input state across the re-render)
  // guarantees nothing has to be re-entered, regardless of exactly why a
  // given failure path is reached.
  values?: {
    title: string;
    author: string;
    format: string;
    publisher: string;
    publishYear: string;
    specialNotes: string;
  };
}

export async function createBookFromScan(
  _prevState: ScanFormState,
  formData: FormData,
): Promise<ScanFormState> {
  const values = {
    title: formData.get("title")?.toString() ?? "",
    author: formData.get("author")?.toString() ?? "",
    format: formData.get("format")?.toString() ?? "",
    publisher: formData.get("publisher")?.toString() ?? "",
    publishYear: formData.get("publishYear")?.toString() ?? "",
    specialNotes: formData.get("specialNotes")?.toString() ?? "",
  };

  const selectedCoverDataUrl = formData.get("selectedCoverDataUrl")?.toString() ?? "";
  const selectedCoverSource = formData.get("selectedCoverSource")?.toString();

  let coverImagePath: string | undefined;
  if (selectedCoverDataUrl) {
    if (selectedCoverSource === "url") {
      const coverResult = await saveCoverFromUrl(selectedCoverDataUrl);
      if ("error" in coverResult) {
        return { error: coverResult.error, values };
      }
      coverImagePath = coverResult.coverImagePath;
    } else if (selectedCoverSource === "dataUrl") {
      try {
        coverImagePath = await saveCoverImage(selectedCoverDataUrl);
      } catch {
        return { error: "Invalid cover image", values };
      }
    } else {
      return { error: "Invalid cover selection", values };
    }
  }

  const result = await createBookWithCopyData({
    title: values.title,
    author: values.author,
    isbn: formData.get("isbn")?.toString() ?? "",
    format: values.format,
    publisher: values.publisher,
    publishYear: values.publishYear,
    specialNotes: values.specialNotes,
    coverImagePath,
  });

  if ("error" in result) {
    if (coverImagePath) {
      await deleteCoverImage(coverImagePath);
    }
    return { error: result.error, values };
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
