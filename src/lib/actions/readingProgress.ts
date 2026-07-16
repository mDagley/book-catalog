"use server";

import { revalidatePath } from "next/cache";
import {
  updateReadStatusData,
  updateRatingData,
  clearReadStatusManualData,
  clearRatingManualData,
} from "@/lib/readingProgress";

export async function updateReadStatus(bookId: string, formData: FormData): Promise<void> {
  const result = await updateReadStatusData(bookId, (formData.get("readStatus") as string) ?? "");
  // No client-visible error state for this control -- the <select> only ever
  // submits one of its own valid option values, so an error here can only
  // come from a tampered request, not a normal user interaction.
  if ("error" in result) return;
  revalidatePath(`/books/${bookId}`);
  revalidatePath("/");
}

export async function updateRating(bookId: string, formData: FormData): Promise<void> {
  const result = await updateRatingData(bookId, (formData.get("rating") as string) ?? "");
  if ("error" in result) return;
  revalidatePath(`/books/${bookId}`);
  revalidatePath("/");
}

export async function clearReadStatusManual(bookId: string): Promise<void> {
  await clearReadStatusManualData(bookId);
  revalidatePath(`/books/${bookId}`);
}

export async function clearRatingManual(bookId: string): Promise<void> {
  await clearRatingManualData(bookId);
  revalidatePath(`/books/${bookId}`);
}
