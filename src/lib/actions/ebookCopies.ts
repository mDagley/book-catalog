"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateEbookCopyCoverData } from "@/lib/ebookCopies";
import type { CopyFormState } from "@/lib/copies";
import { stringField, optionalStringField } from "@/lib/formData";

export async function updateEbookCopyCover(
  copyId: string,
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await updateEbookCopyCoverData(copyId, {
    selectedCoverDataUrl: stringField(formData, "selectedCoverDataUrl"),
    selectedCoverSource: optionalStringField(formData, "selectedCoverSource"),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}/edit`);
}
