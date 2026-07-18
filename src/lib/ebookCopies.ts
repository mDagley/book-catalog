import { prisma } from "@/lib/prisma";
import { resolveCoverUpdate, type CoverSelectionInput } from "@/lib/copyCovers";

export async function updateEbookCopyCoverData(
  copyId: string,
  input: CoverSelectionInput,
): Promise<{ ok: true } | { error: string }> {
  const existing = await prisma.ebookCopy.findUniqueOrThrow({
    where: { id: copyId },
    select: { coverImagePath: true },
  });

  const result = await resolveCoverUpdate(input, existing.coverImagePath);
  if ("error" in result) {
    return result;
  }

  await prisma.ebookCopy.update({
    where: { id: copyId },
    data: { coverImagePath: result.coverImagePath },
  });

  return { ok: true };
}
