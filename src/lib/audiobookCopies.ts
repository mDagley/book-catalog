import { prisma } from "@/lib/prisma";
import { resolveCoverUpdate, type CoverSelectionInput } from "@/lib/copyCovers";

export async function updateAudiobookCopyCoverData(
  copyId: string,
  input: CoverSelectionInput,
): Promise<{ ok: true } | { error: string }> {
  const existing = await prisma.audiobookCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { coverImagePath: true },
  });

  const result = await resolveCoverUpdate(input, existing.coverImagePath);
  if ("error" in result) {
    return result;
  }

  await prisma.audiobookCopy.update({
    where: { id: copyId },
    data: { coverImagePath: result.coverImagePath },
  });

  return { ok: true };
}
