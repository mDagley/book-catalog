import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  updateReadStatusData,
  updateRatingData,
  clearReadStatusManualData,
  clearRatingManualData,
} from "@/lib/readingProgress";

afterEach(async () => {
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test Reading Progress" } } });
});

async function createTestBook(
  overrides: Partial<{
    readStatus: "TO_READ" | "READING" | "READ" | null;
    readStatusManual: boolean;
    rating: number | null;
    ratingManual: boolean;
  }> = {},
) {
  return prisma.book.create({ data: { title: "Test Reading Progress Book", ...overrides } });
}

describe("updateReadStatusData", () => {
  it("sets readStatus and marks it manual", async () => {
    const book = await createTestBook();

    const result = await updateReadStatusData(book.id, "READING");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READING");
    expect(updated.readStatusManual).toBe(true);
  });

  it("clears readStatus to null on an empty value, still marking it manual", async () => {
    const book = await createTestBook({ readStatus: "READ", readStatusManual: false });

    const result = await updateReadStatusData(book.id, "");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBeNull();
    expect(updated.readStatusManual).toBe(true);
  });

  it("returns an error for an invalid status value", async () => {
    const book = await createTestBook();

    const result = await updateReadStatusData(book.id, "NOT_A_STATUS");

    expect(result).toEqual({ error: "Invalid read status" });
  });
});

describe("updateRatingData", () => {
  it("sets a rating from 1-5 and marks it manual", async () => {
    const book = await createTestBook();

    const result = await updateRatingData(book.id, "4");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.rating).toBe(4);
    expect(updated.ratingManual).toBe(true);
  });

  it("clears rating to null on an empty value", async () => {
    const book = await createTestBook({ rating: 5, ratingManual: false });

    const result = await updateRatingData(book.id, "");

    expect(result).toEqual({ ok: true });
    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.rating).toBeNull();
  });

  it("returns an error for a rating outside 1-5", async () => {
    const book = await createTestBook();

    const result = await updateRatingData(book.id, "6");

    expect(result).toEqual({ error: "Rating must be a whole number from 1 to 5" });
  });

  it("returns an error for a non-numeric rating", async () => {
    const book = await createTestBook();

    const result = await updateRatingData(book.id, "abc");

    expect(result).toEqual({ error: "Rating must be a whole number from 1 to 5" });
  });
});

describe("clearReadStatusManualData", () => {
  it("clears the manual flag without changing the status value", async () => {
    const book = await createTestBook({ readStatus: "READ", readStatusManual: true });

    await clearReadStatusManualData(book.id);

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.readStatus).toBe("READ");
    expect(updated.readStatusManual).toBe(false);
  });
});

describe("clearRatingManualData", () => {
  it("clears the manual flag without changing the rating value", async () => {
    const book = await createTestBook({ rating: 3, ratingManual: true });

    await clearRatingManualData(book.id);

    const updated = await prisma.book.findUniqueOrThrow({ where: { id: book.id } });
    expect(updated.rating).toBe(3);
    expect(updated.ratingManual).toBe(false);
  });
});
