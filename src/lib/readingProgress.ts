import { prisma } from "@/lib/prisma";
import type { ReadStatus } from "@prisma/client";

export const READ_STATUS_VALUES = ["TO_READ", "READING", "READ"] as const satisfies readonly ReadStatus[];

function parseReadStatusInput(raw: string): { value: ReadStatus | null } | { error: string } {
  if (raw === "") return { value: null };
  if ((READ_STATUS_VALUES as readonly string[]).includes(raw)) {
    return { value: raw as ReadStatus };
  }
  return { error: "Invalid read status" };
}

function parseRatingInput(raw: string): { value: number | null } | { error: string } {
  if (raw === "") return { value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return { error: "Rating must be a whole number from 1 to 5" };
  }
  return { value: n };
}

export async function updateReadStatusData(
  bookId: string,
  rawStatus: string,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseReadStatusInput(rawStatus);
  if ("error" in parsed) return parsed;

  await prisma.book.update({
    where: { id: bookId },
    data: { readStatus: parsed.value, readStatusManual: true },
  });
  return { ok: true };
}

export async function updateRatingData(
  bookId: string,
  rawRating: string,
): Promise<{ ok: true } | { error: string }> {
  const parsed = parseRatingInput(rawRating);
  if ("error" in parsed) return parsed;

  await prisma.book.update({
    where: { id: bookId },
    data: { rating: parsed.value, ratingManual: true },
  });
  return { ok: true };
}

export async function clearReadStatusManualData(bookId: string): Promise<void> {
  await prisma.book.update({ where: { id: bookId }, data: { readStatusManual: false } });
}

export async function clearRatingManualData(bookId: string): Promise<void> {
  await prisma.book.update({ where: { id: bookId }, data: { ratingManual: false } });
}
