"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateEbookCopyCoverData } from "@/lib/ebookCopies";
import type { CopyFormState } from "@/lib/copies";

export async function updateEbookCopyCover(
  copyId: string,
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await updateEbookCopyCoverData(copyId, {
    selectedCoverDataUrl: formData.get("selectedCoverDataUrl")?.toString() ?? "",
    selectedCoverSource: formData.get("selectedCoverSource")?.toString(),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  redirect(`/books/${bookId}/edit`);
}
