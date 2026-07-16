"use server";

import { revalidatePath } from "next/cache";
import { mergeBooksData } from "@/lib/duplicates";

export async function mergeBooks(keepId: string, mergeIds: string[]): Promise<void> {
  const result = await mergeBooksData(keepId, mergeIds);
  // Thrown (not silently ignored) so a failed merge surfaces as a visible
  // error instead of the page just revalidating as if nothing went wrong --
  // this is a rarely-used internal cleanup tool, not a polished end-user
  // form, so Next's default error handling is an acceptable way to surface
  // it rather than building out a dedicated error-display state for it.
  if ("error" in result) {
    throw new Error(result.error);
  }
  revalidatePath("/books/duplicates");
  revalidatePath("/books");
  revalidatePath("/");
}
