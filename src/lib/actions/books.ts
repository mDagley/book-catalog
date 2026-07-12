"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createBookWithCopyData, updateBookData, type BookFormState } from "@/lib/books";

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
