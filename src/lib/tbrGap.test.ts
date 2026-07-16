import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { getTbrGap } from "@/lib/tbrGap";

afterEach(async () => {
  await prisma.goodreadsTbrItem.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
  await prisma.physicalCopy.deleteMany({
    where: { book: { title: { startsWith: "Test TBR" } } },
  });
  await prisma.ebookCopy.deleteMany({ where: { book: { title: { startsWith: "Test TBR" } } } });
  await prisma.audiobookCopy.deleteMany({
    where: { book: { title: { startsWith: "Test TBR" } } },
  });
  await prisma.book.deleteMany({ where: { title: { startsWith: "Test TBR" } } });
});

describe("getTbrGap", () => {
  it("excludes a TBR item that matches an owned physical book", async () => {
    await prisma.book.create({
      data: { title: "Test TBR Owned Book", copies: { create: { format: "PAPERBACK" } } },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Owned Book", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Owned Book")).toBe(false);
  });

  it("excludes a TBR item that matches an ebook/audiobook-only Book", async () => {
    await prisma.book.create({
      data: {
        title: "Test TBR Abs Book",
        hasAudiobook: true,
        audiobookCopies: { create: { absItemId: "test-tbr-abs-1" } },
      },
    });
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Abs Book", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Abs Book")).toBe(false);
  });

  it("includes a TBR item not owned in any form", async () => {
    await prisma.goodreadsTbrItem.create({
      data: { title: "Test TBR Not Owned", author: "Someone" },
    });

    const gap = await getTbrGap();

    expect(gap.some((item) => item.title === "Test TBR Not Owned")).toBe(true);
  });
});
