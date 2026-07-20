"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateAudiobookCopyCoverData } from "@/lib/audiobookCopies";
import type { CopyFormState } from "@/lib/copies";

export async function updateAudiobookCopyCover(
  copyId: string,
  bookId: string,
  _prevState: CopyFormState,
  formData: FormData,
): Promise<CopyFormState> {
  const result = await updateAudiobookCopyCoverData(copyId, {
    selectedCoverDataUrl: formData.get("selectedCoverDataUrl")?.toString() ?? "",
    selectedCoverSource: formData.get("selectedCoverSource")?.toString(),
  });

  if ("error" in result) {
    return result;
  }

  revalidatePath(`/books/${bookId}`);
  revalidatePath(`/books/${bookId}/edit`);
  redirect(`/books/${bookId}/edit`);
}
