"use server";

import { revalidatePath } from "next/cache";
import { mergeBooksData } from "@/lib/duplicates";

export async function mergeBooks(keepId: string, mergeIds: string[]): Promise<void> {
  await mergeBooksData(keepId, mergeIds);
  revalidatePath("/books/duplicates");
  revalidatePath("/books");
  revalidatePath("/");
}
