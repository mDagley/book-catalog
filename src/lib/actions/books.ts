"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createBookWithCopyData,
  saveCoverFromUrl,
  updateBookData,
  updateSeriesData,
  type BookFormState,
} from "@/lib/books";
import { deleteCoverImage, saveCoverImage } from "@/lib/coverStorage";

// A <select>/<input> field always submits as a string, but FormData.get()'s
// return type is `FormDataEntryValue | null` (string | File | null) --
// `as string` would silently keep a `File` instance if this field somehow
// arrived as one (e.g. a hand-crafted multipart request), and `?.toString()`
// isn't a safe substitute either: File/Blob inherit Object.prototype's
// Symbol.toStringTag-aware toString(), so `file.toString()` returns the real
// string `"[object File]"` -- not undefined, not a crash. That string is
// non-empty, passes `.trim()`/required-field checks downstream, and would
// get persisted as a book's actual title/author/etc. Checking the real
// runtime type instead means a tampered request's field is coerced to ""
// and rejected by validation, rather than silently writing garbage data.
function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Same guarantee as stringField, for fields where "absent" (undefined) is a
// meaningful, distinct state from "present but empty" -- coerces a File (or
// anything else non-string) to undefined rather than "".
function optionalStringField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function createBookWithCopy(
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const result = await createBookWithCopyData({
    title: stringField(formData, "title"),
    author: stringField(formData, "author"),
    isbn: stringField(formData, "isbn"),
    format: stringField(formData, "format"),
    publisher: stringField(formData, "publisher"),
    publishYear: stringField(formData, "publishYear"),
    specialNotes: stringField(formData, "specialNotes"),
    coverImagePath: optionalStringField(formData, "coverImagePath"),
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
    title: stringField(formData, "title"),
    author: stringField(formData, "author"),
    format: stringField(formData, "format"),
    publisher: stringField(formData, "publisher"),
    publishYear: stringField(formData, "publishYear"),
    specialNotes: stringField(formData, "specialNotes"),
  };

  const selectedCoverDataUrl = stringField(formData, "selectedCoverDataUrl");
  const selectedCoverSource = optionalStringField(formData, "selectedCoverSource");

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
    isbn: stringField(formData, "isbn"),
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
    title: stringField(formData, "title"),
    author: stringField(formData, "author"),
    isbn: stringField(formData, "isbn"),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}/edit`);
}

export async function updateSeries(
  bookId: string,
  _prevState: BookFormState,
  formData: FormData,
): Promise<BookFormState> {
  const result = await updateSeriesData(bookId, {
    seriesName: stringField(formData, "seriesName"),
    seriesPosition: stringField(formData, "seriesPosition"),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath("/books");
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}/edit`);
}
