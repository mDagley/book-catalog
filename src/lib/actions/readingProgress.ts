"use server";

import { revalidatePath } from "next/cache";
import {
  updateReadStatusData,
  updateRatingData,
  clearReadStatusManualData,
  clearRatingManualData,
} from "@/lib/readingProgress";

// A <select>/<input> field always submits as a string, but FormData.get()'s
// return type is `FormDataEntryValue | null` (string | File | null) --
// `as string` would silently keep a `File` instance if this field somehow
// arrived as one (e.g. a hand-crafted multipart request), rather than
// actually converting it. Checking the real runtime type instead of casting
// means a tampered request falls through to "" (and downstream validation)
// rather than a stray File object propagating into the parser.
function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function updateReadStatus(bookId: string, formData: FormData): Promise<void> {
  const result = await updateReadStatusData(bookId, stringField(formData, "readStatus"));
  // No client-visible error state for this control -- the <select> only ever
  // submits one of its own valid option values, so an error here can only
  // come from a tampered request, not a normal user interaction.
  if ("error" in result) return;
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  revalidatePath("/");
}

export async function updateRating(bookId: string, formData: FormData): Promise<void> {
  const result = await updateRatingData(bookId, stringField(formData, "rating"));
  if ("error" in result) return;
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  revalidatePath("/");
}

export async function clearReadStatusManual(bookId: string): Promise<void> {
  await clearReadStatusManualData(bookId);
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
}

export async function clearRatingManual(bookId: string): Promise<void> {
  await clearRatingManualData(bookId);
  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
}
