import { saveCoverFromUrl } from "@/lib/books";
import { saveCoverImage, deleteCoverImage } from "@/lib/coverStorage";

// The two hidden-field names CoverPicker (and the new CoverEditor) submit:
// selectedCoverDataUrl holds either a base64 data URL (source "dataUrl") or
// a plain https URL (source "url") -- same naming CoverPicker already
// established; kept as-is here for consistency rather than renamed.
export interface CoverSelectionInput {
  selectedCoverDataUrl: string;
  selectedCoverSource: string | undefined;
}

// Given new cover selection input and a copy's current coverImagePath,
// resolves what the copy's coverImagePath should become: unchanged if
// nothing new was selected, or a freshly saved file (with the old one
// cleaned up, if there was one and it's being replaced). Mirrors the
// inline cover-resolution logic createBookFromScan (src/lib/actions/books.ts)
// already has for book creation, generalized to also handle replacing an
// existing cover -- book creation never has an "existing" cover to replace,
// so that logic never needed this.
export async function resolveCoverUpdate(
  input: CoverSelectionInput,
  currentCoverImagePath: string | null,
): Promise<{ coverImagePath: string | null } | { error: string }> {
  if (!input.selectedCoverDataUrl) {
    return { coverImagePath: currentCoverImagePath };
  }

  let coverImagePath: string;
  if (input.selectedCoverSource === "url") {
    const coverResult = await saveCoverFromUrl(input.selectedCoverDataUrl);
    if ("error" in coverResult) {
      return { error: coverResult.error };
    }
    coverImagePath = coverResult.coverImagePath;
  } else if (input.selectedCoverSource === "dataUrl") {
    try {
      coverImagePath = await saveCoverImage(input.selectedCoverDataUrl);
    } catch {
      return { error: "Invalid cover image" };
    }
  } else {
    return { error: "Invalid cover selection" };
  }

  if (currentCoverImagePath && currentCoverImagePath !== coverImagePath) {
    await deleteCoverImage(currentCoverImagePath);
  }

  // This save/delete sequence isn't wrapped in a $transaction with the
  // caller's DB update that persists coverImagePath -- this app is
  // single-user, so a mid-sequence crash leaving a stale DB reference or
  // an orphaned file is an accepted risk, not an oversight.
  return { coverImagePath };
}
